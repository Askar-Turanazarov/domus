// The steps of the parallel test (15 §4). Each one runs real operations at the same time and says what came out; none of
// them knows which base it is on. `db` must give as many connections as there are parallel operations (Neon: a Pool of 20).
// A step returns { step, attempts, ok, ms, failures: [text] } — ok = how many operations did the one right thing.
import crypto from 'node:crypto';
import Stripe from 'stripe';
import { createHold } from '../../server/core/bookings.js';
import { inTx } from '../../server/core/tx.js';
import { markSucceeded } from '../../server/core/payments.js';
import { handleClick, clickRequest } from '../../server/payments/click.js';
import { handleStripeWebhook } from '../../server/payments/stripe.js';
import { seedBase } from '../../server/db/seed/base.js';
import { qstashSignature } from './qstash.js';

const WEB = { type: 'client', id: null, role: 'client', channel: 'web' };
const SYSTEM = { type: 'system', id: null, role: 'system', channel: 'system' };
export const PARALLEL = 20;
export const STRIPE_ENV = { STRIPE_SECRET_KEY: 'sk_test_neon_concurrency', STRIPE_WEBHOOK_SECRET: 'whsec_neon_concurrency' };

const phoneOf = (round, i, tag = 0) => `+99890${tag}${round % 10}${String(i).padStart(5, '0')}`;   // 90 + 7 digits
const timed = async fn => { const t = performance.now(); const out = await fn(); return { ...out, ms: Math.round(performance.now() - t) }; };
const codeOf = r => r.reason?.code ?? r.reason?.message ?? String(r.reason);

// 15 §4 step 1: every business table emptied, the base filled again (apartments, settings).
export async function resetBase(db) {
  const tables = await db.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`);
  await db.exec(`TRUNCATE ${tables.map(t => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await seedBase(db);
}

const offerVersion = async db => (await db.one(`SELECT value FROM settings WHERE key = 'offer_version'`).catch(() => null))?.value ?? '2026-10-27';

// A held booking with one client, straight through the core.
async function heldBooking(db, apartmentNo, tag) {
  const { booking } = await createHold(db, { apartmentNo, client: { name: `Клиент ${tag}`, phone: phoneOf(9, apartmentNo, 1) },
    channel: 'web', viaChat: true }, WEB, { env: {} });
  return db.one('SELECT * FROM bookings WHERE id = $1', [booking.id]);
}

const insertPayment = (db, b, { code, provider, status, providerRef = null }) => db.one(
  `INSERT INTO payments (code, kind, booking_id, client_id, provider, amount, status, provider_ref, expires_at, created_by, created_at, updated_at)
   VALUES ($1, 'deposit', $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) RETURNING *`,
  [code, b.id, b.client_id, provider, b.deposit_amount, status, providerRef, b.expires_at, JSON.stringify(SYSTEM), new Date()]);

// Step 2: 20 holds on one apartment from 20 clients → one held, nineteen apartment_not_free, no other error.
export const holds = (db, { round, apartmentNo = 41 }) => timed(async () => {
  const results = await Promise.allSettled(Array.from({ length: PARALLEL }, (_, i) => createHold(db,
    { apartmentNo, client: { name: `Клиент ${i}`, phone: phoneOf(round, i) }, channel: 'web', viaChat: true }, WEB, { env: {} })));
  const failures = [];
  const ok = results.filter(r => r.status === 'fulfilled').length;
  for (const r of results.filter(x => x.status === 'rejected')) if (r.reason?.code !== 'apartment_not_free') failures.push(`unexpected error: ${codeOf(r)}`);
  if (ok !== 1) failures.push(`${ok} holds succeeded, expected 1`);
  const held = await db.one(`SELECT count(*)::int AS n FROM bookings WHERE apartment_no = $1 AND status = 'held'`, [apartmentNo]);
  if (held.n !== 1) failures.push(`${held.n} held bookings on the apartment, expected 1`);
  return { step: 'holds', attempts: PARALLEL, ok, failures };
});

// Step 3: the same through the HTTP API of a server on the same base; each request comes from its own address.
export const httpHolds = (db, { round, baseUrl, apartmentNo = 42 }) => timed(async () => {
  const version = await offerVersion(db);
  const answers = await Promise.all(Array.from({ length: PARALLEL }, async (_, i) => {
    try {
      const r = await fetch(`${baseUrl}/api/bookings/hold`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.${round}.${i}.7`,
          'idempotency-key': `neon-test-${round}-${i}-${crypto.randomUUID()}` },
        body: JSON.stringify({ apartmentNo, name: `Клиент ${i}`, phone: phoneOf(round, i, 2), consent: { version, privacy: true } }) });
      if (r.status === 201 || r.status === 409) return r.status;
      return `${r.status} ${(await r.text()).slice(0, 160)}`;
    } catch (e) { return `fetch: ${e.message}`; }
  }));
  const count = s => answers.filter(a => a === s).length;
  const failures = [];
  if (count(201) !== 1) failures.push(`${count(201)} answers 201, expected 1`);
  if (count(409) !== PARALLEL - 1) failures.push(`${count(409)} answers 409, expected ${PARALLEL - 1}`);
  const other = answers.filter(a => a !== 201 && a !== 409);
  if (other.length) failures.push(`other answers: ${[...new Set(other)].join(', ')}`);
  const held = await db.one(`SELECT count(*)::int AS n FROM bookings WHERE apartment_no = $1 AND status = 'held'`, [apartmentNo]);
  if (held.n !== 1) failures.push(`${held.n} held bookings on the apartment, expected 1`);
  return { step: 'http-holds', attempts: PARALLEL, ok: count(201), failures };
});

// Step 4a: 10 different payments of one booking all report «paid» at once → one succeeded, nine refund_due.
export const payments = (db, { round, apartmentNo = 43 }) => timed(async () => {
  const b = await heldBooking(db, apartmentNo, 'pay');
  const rows = [];
  // One booking has at most one open payment (payments_one_open_booking); the other nine are Stripe sessions the client
  // opened before and abandoned — Stripe can still take their money, and then markSucceeded takes them as late.
  for (let i = 0; i < 10; i++) rows.push(await insertPayment(db, b, { code: `P-N${round}-${i}`, provider: 'stripe', status: i ? 'cancelled' : 'processing', providerRef: `cs_test_${round}_${i}` }));
  const results = await Promise.allSettled(rows.map(p => inTx(db, { env: {} }, (q, fx) => markSucceeded(q, fx, { now: () => new Date(), env: {} },
    { paymentId: p.id, providerRef: p.provider_ref }))));
  const failures = results.filter(r => r.status === 'rejected').map(r => `payment error: ${codeOf(r)}`);
  const by = Object.groupBy(await db.query('SELECT status FROM payments WHERE booking_id = $1', [b.id]), r => r.status);
  const succeeded = by.succeeded?.length ?? 0;
  const returned = (by.refund_due?.length ?? 0) + (by.refunded?.length ?? 0);
  if (succeeded !== 1) failures.push(`${succeeded} succeeded payments, expected 1`);
  if (returned !== 9) failures.push(`${returned} payments to return, expected 9`);
  const booked = await db.one(`SELECT count(*)::int AS n FROM bookings WHERE apartment_no = $1 AND status = 'booked'`, [apartmentNo]);
  if (booked.n !== 1) failures.push(`${booked.n} booked bookings on the apartment, expected 1`);
  return { step: 'payments', attempts: 10, ok: succeeded, failures };
});

// Step 4b: one Stripe event delivered 10 times at once → handled once, nine «duplicate». Signed with the real library.
export const stripeDuplicates = (db, { round, apartmentNo = 44 }) => timed(async () => {
  const b = await heldBooking(db, apartmentNo, 'stripe');
  const p = await insertPayment(db, b, { code: `P-S${round}`, provider: 'stripe', status: 'processing', providerRef: `cs_test_${round}` });
  const payload = JSON.stringify({ id: `evt_neon_${round}_${crypto.randomUUID()}`, object: 'event', type: 'checkout.session.completed',
    data: { object: { id: p.provider_ref, payment_status: 'paid', payment_intent: `pi_${round}`, metadata: { paymentId: p.id }, client_reference_id: p.id } } });
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: STRIPE_ENV.STRIPE_WEBHOOK_SECRET });
  const stripe = { paymentIntents: { retrieve: async () => ({ latest_charge: { payment_method_details: { card: { brand: 'visa', last4: '4242' } } } }) } };
  const results = await Promise.allSettled(Array.from({ length: 10 }, () =>
    handleStripeWebhook(db, Buffer.from(payload), signature, { env: STRIPE_ENV, stripe })));
  const failures = results.filter(r => r.status === 'rejected').map(r => `webhook error: ${codeOf(r)}`);
  const bodies = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  const fresh = bodies.filter(r => r.status === 200 && r.body.received).length;
  const dup = bodies.filter(r => r.status === 200 && r.body.duplicate).length;
  if (fresh !== 1 || dup !== 9) failures.push(`${fresh} handled and ${dup} duplicates, expected 1 and 9`);
  const rows = await db.query('SELECT status FROM payments WHERE booking_id = $1', [b.id]);
  if (rows.filter(r => r.status === 'succeeded').length !== 1) failures.push('the payment is not succeeded exactly once');
  const events = await db.one(`SELECT count(*)::int AS n FROM provider_events WHERE provider = 'stripe' AND payment_id = $1`, [p.id]);
  if (events.n !== 1) failures.push(`${events.n} provider_events rows, expected 1`);
  return { step: 'stripe-duplicates', attempts: 10, ok: fresh, failures };
});

// Step 5: 10 Click «Complete» with one click_trans_id → one success (0), nine «already paid» (−4), the status unchanged.
export const clickDuplicates = (db, { round, apartmentNo = 45 }) => timed(async () => {
  const b = await heldBooking(db, apartmentNo, 'click');
  const p = await insertPayment(db, b, { code: `P-C${round}`, provider: 'click', status: 'pending' });
  const ids = { clickTransId: 2_950_000 + round, paydocId: 3_810_000 + round };
  const prepared = await handleClick(db, clickRequest(p, 0, { ...ids, at: new Date() }), 0, { env: {} });
  const failures = [];
  if (prepared.error !== 0) return { step: 'click-duplicates', attempts: 10, ok: 0, failures: [`Prepare answered ${prepared.error}`] };
  const results = await Promise.allSettled(Array.from({ length: 10 }, () =>
    handleClick(db, clickRequest(p, 1, { ...ids, prepareId: prepared.merchant_prepare_id, at: new Date() }), 1, { env: {} })));
  for (const r of results.filter(x => x.status === 'rejected')) failures.push(`complete error: ${codeOf(r)}`);
  const errors = results.filter(r => r.status === 'fulfilled').map(r => r.value.error);
  const ok = errors.filter(e => e === 0).length;
  if (ok !== 1 || errors.filter(e => e === -4).length !== 9) failures.push(`answers: ${errors.join(',')}; expected one 0 and nine −4`);
  const rows = await db.query('SELECT status FROM payments WHERE booking_id = $1', [b.id]);
  if (rows.length !== 1 || rows[0].status !== 'succeeded') failures.push(`payment status: ${rows.map(r => r.status).join(',')}, expected one succeeded`);
  return { step: 'click-duplicates', attempts: 10, ok, failures };
});

// Step 6: 50 due jobs, 5 callers of the job runner at once (POST /api/jobs/run with a QStash signature) → each job once.
export const jobs = (db, { round, baseUrl, qstash }) => timed(async () => {
  const at = new Date();
  const ids = [];
  for (let i = 0; i < 50; i++) {
    const apt = i < 40 ? i + 1 : i + 6;                  // 1–40 and 46–55: 41–45 belong to the other steps
    const c = await db.one(`INSERT INTO clients (name, phone, lang, channels, first_channel, created_at, updated_at)
      VALUES ($1, $2, 'ru', ARRAY['web'], 'web', $3, $3) RETURNING id`, [`Клиент ${i}`, phoneOf(round, i, 3), at]);
    const expiresAt = new Date(at.getTime() - 60e3);
    const { price } = await db.one('SELECT price FROM apartments WHERE no = $1', [apt]);
    const b = await db.one(`INSERT INTO bookings (apartment_no, client_id, status, channel, created_by, expires_at, held_at, deposit_amount,
        price_at_booking, updated_at) VALUES ($1, $2, 'held', 'web', $3, $4, $5, 10000000, $6, $5) RETURNING id`,
    [apt, c.id, JSON.stringify(WEB), expiresAt, new Date(at.getTime() - 16 * 60e3), price]);
    const j = await db.one(`INSERT INTO jobs (type, run_at, payload, status, dedupe_key, created_at, updated_at)
      VALUES ('hold.expire', $1, $2, 'scheduled', $3, $4, $4) RETURNING id`,
    [new Date(at.getTime() - 30e3), JSON.stringify({ bookingId: b.id, expectedExpiresAt: expiresAt.toISOString() }), `neon:${round}:${i}`, at]);
    ids.push(j.id);
  }
  const failures = [];
  const call = async () => {
    const body = JSON.stringify({});
    const r = await fetch(`${baseUrl}/api/jobs/run`, { method: 'POST', body,
      headers: { 'content-type': 'application/json', 'upstash-signature': qstashSignature(body, qstash) } });
    return r.status;
  };
  for (let wave = 0; wave < 8; wave++) {
    const statuses = await Promise.all(Array.from({ length: 5 }, () => call().catch(e => `fetch: ${e.message}`)));
    const bad = statuses.filter(s => s !== 200);
    if (bad.length) { failures.push(`job runner answered ${[...new Set(bad)].join(', ')}`); break; }
    if (!(await db.one(`SELECT count(*)::int AS n FROM jobs WHERE id = ANY($1) AND status IN ('scheduled', 'running')`, [ids])).n) break;
  }
  const rows = await db.query('SELECT status, attempts FROM jobs WHERE id = ANY($1)', [ids]);
  const once = rows.filter(r => r.status === 'done' && r.attempts === 1).length;
  if (once !== 50) failures.push(`${once} of 50 jobs done exactly once (${JSON.stringify(Object.groupBy(rows, r => `${r.status}/${r.attempts}`))})`);
  const left = await db.one(`SELECT count(*)::int AS n FROM bookings WHERE status = 'held' AND expires_at < $1`, [new Date()]);
  if (left.n) failures.push(`${left.n} expired holds are still held`);
  return { step: 'jobs', attempts: 50, ok: once, failures };
});

// Steps 2–6 once.
export async function runRound(db, ctx) {
  await resetBase(db);
  const out = [];
  for (const step of [holds, httpHolds, payments, stripeDuplicates, clickDuplicates, jobs]) {
    try { out.push({ round: ctx.round, ...(await step(db, ctx)) }); } catch (e) {
      out.push({ round: ctx.round, step: step.name, attempts: 0, ok: 0, ms: 0, failures: [`step crashed: ${e.code ?? e.message}`] });
    }
  }
  return out;
}
