// The payment state (05 §2, §3, §7) and invariants P1–P5 (15 §3.2): startPayment, markSucceeded / markFailed /
// cancelPayment idempotent, closeOpenPayments, payment.reconcile, the reason texts (FR-PAY-07).
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeClock, now } from '../../server/core/clock.js';
import { createHold, releaseHold, sweepExpired } from '../../server/core/bookings.js';
import { startPayment, markSucceeded, markFailed, cancelPayment, paymentView, paymentJobHandlers } from '../../server/core/payments.js';
import { runDue } from '../../server/core/jobs.js';
import { context, inTx } from '../../server/core/tx.js';
import { cardProvider } from '../../server/payments/card.js';
import { enabledProviders } from '../../server/payments/index.js';
import { createTestDb, resetDb } from '../support/db.js';

let db;
const ENV = { LINK_SECRET: 'test-secret', PUBLIC_URL: 'https://domus.test' };
const WEB = { type: 'client', id: null, role: 'client', channel: 'web' };
const OFFER = { version: '2026-10-27' };
before(async () => { db = await createTestDb(); });
after(() => db.close());
beforeEach(async () => {
  await resetDb(db);
  fakeClock.set('2026-10-28T10:00:00+05:00');
});
afterEach(() => fakeClock.reset());

const ctx = () => context({ env: ENV });
const tx = fn => inTx(db, ctx(), (q, fx) => fn(q, fx, ctx()));
const row = id => db.one('SELECT * FROM payments WHERE id = $1', [id]);
const bookingOf = async id => db.one('SELECT * FROM bookings WHERE id = $1', [id]);

async function hold(apartmentNo = 41, { channel = 'web', userId = 77 } = {}) {
  const client = channel === 'web' ? { name: 'Аня', phone: `+9989012345${apartmentNo}` } : { telegram: { userId, chatId: userId } };
  return (await createHold(db, { apartmentNo, client, channel, consent: channel === 'web' ? OFFER : null }, WEB, { env: ENV })).booking;
}
const start = (b, extra = {}, opts = {}) =>
  startPayment(db, { target: { bookingId: b.id }, provider: 'card', consent: null, lang: 'ru', ...extra }, WEB, { env: ENV, ...opts });

test('startPayment: a pending payment with the deposit snapshot (P7), a P- code and the emulator url', async () => {
  const b = await hold();
  await db.query('UPDATE apartments SET price = price + 1 WHERE no = 41');
  const r = await start(b);
  assert.match(r.code, /^P-[2-9A-HJ-NP-Z]{4}$/);
  assert.equal(r.url, `https://domus.test/pay/card/${r.paymentId}`);
  const p = await row(r.paymentId);
  assert.equal(p.status, 'pending');
  assert.equal(Number(p.amount), Number(b.deposit_amount));
  assert.equal(p.currency, 'UZS');
  assert.equal(p.expires_at.getTime(), b.expires_at.getTime());
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM events WHERE type = 'payment.started'`)).n, 1);
});

test('P2: a new startPayment closes the open one (replaced); the same Idempotency-Key returns the same payment', async () => {
  const b = await hold();
  const first = await start(b, { idempotencyKey: 'k1' });
  assert.deepEqual(await start(b, { idempotencyKey: 'k1' }), first);
  await assert.rejects(start(b, { idempotencyKey: 'k1', lang: 'en' }), { code: 'idempotency_conflict' });
  const second = await start(b, { idempotencyKey: 'k2' });
  assert.notEqual(second.paymentId, first.paymentId);
  const old = await row(first.paymentId);
  assert.equal(old.status, 'cancelled');
  assert.equal(old.failure_reason, 'replaced');
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM payments WHERE status IN ('pending', 'processing')`)).n, 1);
});

test('startPayment refuses: consent, paid, closed, under 60 s left, provider off; begin failure → provider_error', async () => {
  const tg = await hold(42, { channel: 'telegram' });
  await assert.rejects(start(tg), { code: 'consent_required' });
  await start(tg, { consent: OFFER });
  assert.equal((await bookingOf(tg.id)).consent_version, OFFER.version);

  const b = await hold();
  await assert.rejects(start(b, { provider: 'stripe' }), { code: 'provider_unavailable' });
  const broken = { card: { ...cardProvider(), begin: async () => { throw new Error('down'); } } };
  await assert.rejects(start(b, {}, { providers: broken }), { code: 'provider_error' });
  const failed = await db.one(`SELECT * FROM payments WHERE booking_id = $1 ORDER BY created_at DESC LIMIT 1`, [b.id]);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failure_reason, 'provider_error');

  fakeClock.advance('870s');
  await assert.rejects(start(b), { code: 'hold_expiring' });
  fakeClock.advance('1m');
  await assert.rejects(start(b), { code: 'booking_closed' });

  const c = await hold(43);
  const p = await start(c);
  await tx((q, fx, x) => markSucceeded(q, fx, x, { paymentId: p.paymentId }));
  await assert.rejects(start(c), { code: 'booking_already_paid' });
});

test('markSucceeded → booking; a repeat changes nothing (P4, DoD-4)', async () => {
  const b = await hold();
  const { paymentId } = await start(b);
  const r = await tx((q, fx, x) => markSucceeded(q, fx, x, { paymentId, providerRef: 'card_abc', cardBrand: 'HUMO', cardMask: '9860 •••• 0001' }));
  assert.equal(r.result, 'booked');
  const before = await row(paymentId);
  assert.equal(before.status, 'succeeded');
  assert.equal(before.card_mask, '9860 •••• 0001');
  assert.equal((await bookingOf(b.id)).status, 'booked');
  const again = await tx((q, fx, x) => markSucceeded(q, fx, x, { paymentId, providerRef: 'card_abc' }));
  assert.equal(again.result, 'already');
  const after = await row(paymentId);
  assert.deepEqual([after.status, after.amount, after.version], [before.status, before.amount, before.version]);
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM events WHERE type = 'payment.succeeded'`)).n, 1);
});

test('P1: a second paid deposit of the same booking → refund_due / duplicate_payment with a refund', async () => {
  const b = await hold();
  const a = await start(b);
  await tx((q, fx, x) => markSucceeded(q, fx, x, { paymentId: a.paymentId }));
  // a second open payment can only appear by force: the indexes forbid two open ones and a booked booking takes no payment
  const extra = await db.one(`INSERT INTO payments (code, kind, booking_id, client_id, provider, amount, status, created_by, created_at, updated_at)
    VALUES ('P-ZZZZ', 'deposit', $1, $2, 'card', $3, 'pending', '{}', $4, $4) RETURNING id`, [b.id, b.client_id, b.deposit_amount, now()]);
  const r = await tx((q, fx, x) => markSucceeded(q, fx, x, { paymentId: extra.id }));
  assert.equal(r.result, 'duplicate');
  assert.equal(r.payment.status, 'refund_due');
  const refund = await db.one('SELECT * FROM refunds WHERE payment_id = $1', [extra.id]);
  assert.equal(refund.reason, 'duplicate_payment');
  assert.equal(Number(refund.amount), Number(b.deposit_amount));
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM payments WHERE booking_id = $1 AND status = 'succeeded'`, [b.id])).n, 1);
  await assert.rejects(db.query(`UPDATE payments SET status = 'succeeded' WHERE id = $1`, [extra.id]), /payments_one_deposit/);
});

test('P1 in parallel: two markSucceeded of one payment → one booking, one payment.succeeded', async () => {
  const b = await hold();
  const { paymentId } = await start(b);
  const rs = await Promise.all([1, 2].map(() => tx((q, fx, x) => markSucceeded(q, fx, x, { paymentId }))));
  assert.deepEqual(rs.map(r => r.result).sort(), ['already', 'booked']);
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM events WHERE type = 'booking.paid'`)).n, 1);
});

test('P3: the same provider_ref twice → conflict, one payment keeps it', async () => {
  const a = await start(await hold(41));
  const c = await start(await hold(42));
  await tx((q, fx, x) => markSucceeded(q, fx, x, { paymentId: a.paymentId, providerRef: 'card_same' }));
  await assert.rejects(tx((q, fx, x) => markSucceeded(q, fx, x, { paymentId: c.paymentId, providerRef: 'card_same' })), /payments_provider_ref/);
  assert.equal((await row(c.paymentId)).status, 'pending', 'rolled back');
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM payments WHERE provider_ref = 'card_same'`)).n, 1);
});

test('markFailed / cancelPayment: only from open, once; Telegram client told, reason text in three languages', async () => {
  const b = await hold(41, { channel: 'telegram' });
  const { paymentId } = await start(b, { consent: OFFER });
  const f = await tx((q, fx, x) => markFailed(q, fx, x, { paymentId, reason: 'insufficient_funds' }));
  assert.equal(f.status, 'failed');
  assert.equal(await tx((q, fx, x) => markFailed(q, fx, x, { paymentId, reason: 'bank_declined' })), null);
  assert.equal(await tx((q, fx, x) => cancelPayment(q, fx, x, { paymentId, why: 'cancelled_by_user' })), null);
  assert.equal((await row(paymentId)).failure_reason, 'insufficient_funds');
  const msg = await db.one(`SELECT * FROM outbox WHERE template = 'payment_failed'`);
  assert.equal(msg.vars.reason, 'insufficient_funds');
  assert.equal(msg.vars.apt, 41);
  const view = await db.tx(q => paymentView(q, paymentId, 'uz', { env: ENV }));
  assert.equal(view.failureText, 'Kartada mablag‘ yetarli emas.');
  assert.equal(view.target.status, 'held');
  assert.equal((await db.tx(q => paymentView(q, paymentId, 'en'))).failureText, 'Insufficient funds on the card.');

  const web = await hold(42);
  const w = await start(web);
  await tx((q, fx, x) => markFailed(q, fx, x, { paymentId: w.paymentId, reason: 'bank_declined' }));
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM outbox WHERE template = 'payment_failed'`)).n, 1, 'on the site the page shows it');
});

test('closing the hold closes its open payment: released → booking_closed, swept → hold_expired', async () => {
  const a = await hold(41);
  const pa = await start(a);
  await releaseHold(db, { bookingId: a.id }, WEB, { env: ENV });
  assert.deepEqual([(await row(pa.paymentId)).status, (await row(pa.paymentId)).failure_reason], ['cancelled', 'booking_closed']);

  const b = await hold(42);
  const pb = await start(b);
  fakeClock.advance('16m');
  const r = await tx((q, fx, x) => markSucceeded(q, fx, x, { paymentId: pb.paymentId }));
  assert.equal(r.result, 'late', 'not swept yet: confirmPaid sees the hold is over');
  assert.equal(r.payment.status, 'refund_due');

  const c = await hold(43);
  const pc = await start(c);
  fakeClock.advance('16m');
  await tx((q, fx, x) => sweepExpired(q, fx, x));
  assert.deepEqual([(await row(pc.paymentId)).status, (await row(pc.paymentId)).failure_reason], ['cancelled', 'hold_expired']);
  assert.equal((await tx((q, fx, x) => markSucceeded(q, fx, x, { paymentId: pc.paymentId }))).result, 'invalid', 'an emulator never pays late');
});

test('payment.reconcile: a stale open payment of a closed hold is cancelled; a live hold is left alone', async () => {
  const b = await hold();
  const { paymentId } = await start(b);
  const job = type => db.one(`INSERT INTO jobs (type, run_at, payload, status, created_at, updated_at)
    VALUES ($1, $2, $3, 'scheduled', $2, $2) RETURNING id`, [type, now(), JSON.stringify({ paymentId })]);
  const { handlers } = paymentJobHandlers({ env: ENV });
  await job('payment.reconcile');
  assert.equal((await runDue(db, handlers)).skipped, 1);
  await db.query('UPDATE bookings SET expires_at = $2 WHERE id = $1', [b.id, now()]);     // over, not swept
  await job('payment.reconcile');
  assert.equal((await runDue(db, handlers)).done, 1);
  assert.equal((await row(paymentId)).failure_reason, 'hold_expired');
});

test('providers: card and click on by default, Stripe off without keys; Click live needs every key', async () => {
  assert.deepEqual((await enabledProviders({ env: {} })).map(p => p.id), ['card', 'click']);
  assert.deepEqual((await enabledProviders({ env: { CLICK_MODE: 'live', CLICK_SERVICE_ID: '1' } })).map(p => p.id), ['card']);
});

test('P5: confirmPaid is called only from server/core/payments.js', () => {
  const calls = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (f.endsWith('.js') && /confirmPaid\(/.test(fs.readFileSync(f, 'utf8').replace(/export async function confirmPaid\(/, ''))) {
        calls.push(path.relative('server', f).replace(/\\/g, '/'));
      }
    }
  };
  walk('server');
  assert.deepEqual(calls, ['core/payments.js']);
});
