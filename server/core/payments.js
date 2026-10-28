// The payment state (05 §2, §3, §7): the only place where payments change. The fate of the booking is the core's
// decision (confirmPaid, 03 §5) taken inside the same transaction. Network calls to a provider never hold a lock:
// begin() runs after COMMIT.
import crypto from 'node:crypto';
import { DomainError } from './errors.js';
import { emit } from './events.js';
import { context, inTx, notify, later } from './tx.js';
import { confirmPaid, sweepExpired, settingsOf, effectiveStatus } from './bookings.js';
import { requestRefund } from './refunds.js';
import { bookingPath } from './links.js';
import { confirmPrepaid, orderPath } from './orders.js';
import { getProvider } from '../payments/index.js';
import { failureText } from '../i18n/index.js';

export const OPEN = ['pending', 'processing'];
const PAID = ['succeeded', 'refund_due', 'refunded'];
const CODE_ABC = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';   // no look-alike letters (02 §3.6)
const MIN_LEFT_MS = 60e3;                             // less left of the hold — the payment would almost surely be late
const ORDER_PAY_MS = 30 * 60e3;                       // an order prepayment lives as long as the shortest Stripe session (05 §3.3)
const SYSTEM = { type: 'system', id: null, role: 'system', channel: 'system' };
const iso = d => new Date(d).toISOString();

const newCode = () => `P-${Array.from({ length: 4 }, () => CODE_ABC[crypto.randomInt(CODE_ABC.length)]).join('')}`;
const refsOf = p => ({ paymentId: p.id, bookingId: p.booking_id, orderId: p.order_id, clientId: p.client_id });

async function lockPayment(q, id) {
  const p = await q.one('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [id]);
  if (!p) throw new DomainError('payment_not_found');
  return p;
}

// startPayment (05 §3): input — { target: {bookingId} | {orderId}, provider, consent: {version} | null, lang, idempotencyKey }.
// Phase A — one transaction; phase B — provider.begin after COMMIT. → { paymentId, code, url }.
export async function startPayment(db, input, actor, opts = {}) {
  const { target = {}, provider: providerId, consent = null, lang = 'ru', idempotencyKey = null } = input;
  if (!target.bookingId === !target.orderId) throw new DomainError('invalid_input');
  const ctx = context(opts);
  const provider = await getProvider(providerId, ctx);
  const hash = crypto.createHash('sha256').update(JSON.stringify({ target, providerId, consent, lang })).digest('hex');

  const a = await inTx(db, ctx, async (q, fx) => {
    const at = ctx.now();
    if (idempotencyKey) {                                                                       // 1
      const k = await q.one(`SELECT * FROM idempotency_keys WHERE scope = 'payment' AND key = $1 FOR UPDATE`, [idempotencyKey]);
      if (k && k.request_hash !== hash) throw new DomainError('idempotency_conflict');
      if (k) return { saved: k.response };
    }
    const p = target.orderId ? await openOrderPayment(q, fx, ctx, { orderId: target.orderId, provider, consent, actor })
      : await openDepositPayment(q, fx, ctx, { bookingId: target.bookingId, provider, consent, actor });
    await emit(q, 'payment.started', refsOf(p), { provider: p.provider, amount: Number(p.amount), kind: p.kind }, actor, ctx);  // 8
    if (idempotencyKey) {
      await q.query(`INSERT INTO idempotency_keys (scope, key, request_hash, status, response, created_at)
        VALUES ('payment', $1, $2, 201, $3, $4)`, [idempotencyKey, hash, JSON.stringify({ paymentId: p.id, code: p.code }), at]);
    }
    return { payment: p };
  });

  if (a.saved?.url) return a.saved;                                                             // a repeat after phase B
  const payment = a.payment ?? await db.one('SELECT * FROM payments WHERE id = $1', [a.saved.paymentId]);
  let begun;
  try {                                                                                          // 10
    // Stripe names the line by the booking or the order
    const booking = payment.booking_id && await db.one('SELECT no, apartment_no FROM bookings WHERE id = $1', [payment.booking_id]);
    const order = payment.order_id && await db.one('SELECT no, apartment_no FROM orders WHERE id = $1', [payment.order_id]);
    begun = await provider.begin(payment, { lang, origin: ctx.env.PUBLIC_URL ?? '', booking: booking || {}, order: order || null });
  } catch (e) {                                                                                  // 12
    console.error('payment begin failed:', provider.id, e.message);
    await inTx(db, ctx, (q, fx) => markFailed(q, fx, ctx, { paymentId: payment.id, reason: 'provider_error' }));
    throw new DomainError('provider_error');
  }
  if (begun.ref) {                                                                               // 11 (Stripe session id)
    await db.query(`UPDATE payments SET provider_ref = $2 WHERE id = $1 AND status = 'pending'`, [payment.id, begun.ref]);
  }
  const res = { paymentId: payment.id, code: payment.code, url: begun.url };
  if (idempotencyKey) {                                                                          // 9
    await db.query(`UPDATE idempotency_keys SET response = $3 WHERE scope = 'payment' AND key = $1 AND request_hash = $2`,
      [idempotencyKey, hash, JSON.stringify(res)]);
  }
  return res;
}

// A new payment row with a free code (step 7). → the row.
async function insertPayment(q, { kind, bookingId = null, orderId = null, clientId, provider, amount, expiresAt, actor, at }) {
  const { currency, providerAmount } = provider.money(Number(amount));
  for (let i = 0; i < 5; i++) {
    const p = await q.one(`INSERT INTO payments (code, kind, booking_id, order_id, client_id, provider, amount, currency, provider_amount,
        status, expires_at, created_by, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11, $12, $12)
      ON CONFLICT (code) DO NOTHING RETURNING *`,
    [newCode(), kind, bookingId, orderId, clientId, provider.id, amount, currency, providerAmount, expiresAt, JSON.stringify(actor), at]);
    if (p) return p;
  }
  throw new Error('no free payment code');
}

// Steps 2–7 of 05 §3 for the deposit of a held booking. → the payment row.
async function openDepositPayment(q, fx, ctx, { bookingId, provider, consent, actor }) {
  const at = ctx.now();
  await sweepExpired(q, fx, ctx, { bookingId });                                                // 2
  const b = await q.one('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [bookingId]);
  if (!b) throw new DomainError('booking_not_found');
  if (actor?.type === 'client' && actor.id && actor.id !== b.client_id) throw new DomainError('forbidden');
  if (b.status === 'booked') throw new DomainError('booking_already_paid');
  if (b.status !== 'held') throw new DomainError('booking_closed');
  const left = b.expires_at.getTime() - at.getTime();                                           // 3
  if (left < MIN_LEFT_MS) throw new DomainError('hold_expiring', { n: Math.max(0, Math.round(left / 1000)) });
  const s = await settingsOf(q, ctx);                                                           // 4
  if (b.consent_version !== s.offer_version) {
    if (consent?.version !== s.offer_version) throw new DomainError('consent_required');
    await q.query('UPDATE bookings SET consent_version = $2, consent_at = $3, updated_at = $3 WHERE id = $1', [b.id, s.offer_version, at]);
  }
  if (!provider?.enabled()) throw new DomainError('provider_unavailable');                     // 5
  await closeOpenPayments(q, fx, ctx, { bookingId: b.id, why: 'replaced' });                    // 6
  return insertPayment(q, { kind: 'deposit', bookingId: b.id, clientId: b.client_id, provider, amount: b.deposit_amount,   // 7
    expiresAt: b.expires_at, actor, at });
}

// 05 §3.3: the prepayment of a furniture order — no hold, so no step 3; the payment lives 30 min.
async function openOrderPayment(q, fx, ctx, { orderId, provider, consent, actor }) {
  const at = ctx.now();
  const o = await q.one('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
  if (!o || o.kind !== 'furniture') throw new DomainError('order_not_found');
  if (actor?.type === 'client' && actor.id && actor.id !== o.client_id) throw new DomainError('forbidden');
  if (o.prepaid_at) throw new DomainError('order_already_paid');
  if (o.stage === 'cancelled' || !(Number(o.prepay_amount) > 0)) throw new DomainError('order_closed');
  const s = await settingsOf(q, ctx);
  if (o.consent_version !== s.offer_version) {
    if (consent?.version !== s.offer_version) throw new DomainError('consent_required');
    await q.query('UPDATE orders SET consent_version = $2, updated_at = $3 WHERE id = $1', [o.id, s.offer_version, at]);
  }
  if (!provider?.enabled()) throw new DomainError('provider_unavailable');
  await closeOpenPayments(q, fx, ctx, { orderId: o.id, why: 'replaced' });
  return insertPayment(q, { kind: 'furniture_prepay', orderId: o.id, clientId: o.client_id, provider, amount: o.prepay_amount,
    expiresAt: new Date(at.getTime() + ORDER_PAY_MS), actor, at });
}

// What a payment pays for, as the providers and pages need it (05 §4–§6): live — the money may still be taken; until — the
// latest moment for it; link — where the client goes back; status — of the booking or the order. lock — FOR UPDATE on it.
export async function targetOf(q, p, at, env, { lock = false } = {}) {
  const forUpdate = lock ? ' FOR UPDATE' : '';
  if (p.order_id) {
    const o = await q.one(`SELECT * FROM orders WHERE id = $1${forUpdate}`, [p.order_id]);
    return { type: 'order', row: o, live: !!o && o.stage !== 'cancelled' && !o.prepaid_at && p.expires_at > at,
      until: p.expires_at, link: o ? orderPath(o, env) : null, status: o?.stage ?? null };
  }
  const b = p.booking_id ? await q.one(`SELECT * FROM bookings WHERE id = $1${forUpdate}`, [p.booking_id]) : null;
  return { type: 'booking', row: b, live: !!b && b.status === 'held' && b.expires_at > at,
    until: b?.expires_at ?? null, link: b ? bookingPath(b, env) : null, status: b ? effectiveStatus(b, at) : null };
}

// pending → processing (card accepted and the code given / Click Prepare). Only from an open status. → the row | null.
export async function markProcessing(q, fx, ctx, { paymentId, providerRef = null, clickPrepareId = null, cardBrand = null, cardMask = null }) {
  const p = await lockPayment(q, paymentId);
  if (!OPEN.includes(p.status)) return null;
  return q.one(`UPDATE payments SET status = 'processing', provider_ref = COALESCE($2, provider_ref),
      click_prepare_id = COALESCE($3, click_prepare_id), card_brand = COALESCE($4, card_brand), card_mask = COALESCE($5, card_mask),
      updated_at = $6, version = version + 1
    WHERE id = $1 RETURNING *`, [p.id, providerRef, clickPrepareId, cardBrand, cardMask, ctx.now()]);
}

// 05 §7.1. The money came: confirmPaid decides booking or late payment; a repeat changes nothing (FR-PAY-05).
// → { result: 'booked' | 'prepaid' | 'late' | 'duplicate' | 'already' | 'invalid', payment }.
export async function markSucceeded(q, fx, ctx, { paymentId, providerRef = null, providerPaymentRef = null, cardBrand = null, cardMask = null }) {
  const at = ctx.now();
  const p = await lockPayment(q, paymentId);                                                    // 1
  if (PAID.includes(p.status)) return { result: 'already', payment: p };                        // 2
  let late = false;
  if (!OPEN.includes(p.status)) {                                                               // 3
    if (p.provider !== 'stripe') {
      console.error('invariant_violation: a closed emulator payment succeeded', p.id);
      return { result: 'invalid', payment: p };
    }
    late = true;                                                                                // Stripe paid after we closed it (§6.7)
  }
  const result = p.kind === 'furniture_prepay'                                                   // 4
    ? await confirmPrepaid(q, fx, ctx, { orderId: p.order_id, payment: p })
    : await confirmPaid(q, fx, ctx, { bookingId: p.booking_id, payment: p, late });
  const ok = result === 'booked' || result === 'prepaid';
  let row = await q.one(`UPDATE payments SET status = $2, succeeded_at = $3, provider_ref = COALESCE($4, provider_ref),
      provider_payment_ref = COALESCE($5, provider_payment_ref), card_brand = COALESCE($6, card_brand),
      card_mask = COALESCE($7, card_mask), failure_reason = NULL, updated_at = $3, version = version + 1
    WHERE id = $1 RETURNING *`, [p.id, ok ? 'succeeded' : 'refund_due', at, providerRef, providerPaymentRef, cardBrand, cardMask]);  // 5
  await q.query('DELETE FROM payment_challenges WHERE payment_id = $1', [p.id]);
  await emit(q, 'payment.succeeded', refsOf(p), { provider: p.provider, amount: Number(p.amount), kind: p.kind }, SYSTEM, ctx);  // 6
  if (!ok) {                                                                                     // 7
    await requestRefund(q, fx, ctx, { paymentId: p.id, reason: result === 'duplicate' ? 'duplicate_payment' : 'late_payment', actor: SYSTEM });
    row = await q.one('SELECT * FROM payments WHERE id = $1', [p.id]);
  }
  return { result, payment: row };
}

// 05 §7.2: only from pending/processing, otherwise nothing (idempotent). → the row | null.
async function closePayment(q, fx, ctx, { paymentId, status, reason, details = null, actor = SYSTEM }) {
  const at = ctx.now();
  const p = await lockPayment(q, paymentId);
  if (!OPEN.includes(p.status)) return null;
  const row = await q.one(`UPDATE payments SET status = $2, failure_reason = $3, updated_at = $4, version = version + 1
    WHERE id = $1 RETURNING *`, [p.id, status, reason, at]);
  await q.query('DELETE FROM payment_challenges WHERE payment_id = $1', [p.id]);
  if (status === 'cancelled') {
    await emit(q, 'payment.cancelled', { paymentId: p.id }, { why: reason }, actor, ctx);
    return row;
  }
  const ev = await emit(q, 'payment.failed', refsOf(p), { provider: p.provider, reason, ...(details && { details }) }, actor, ctx);
  const b = p.booking_id && await q.one('SELECT * FROM bookings WHERE id = $1', [p.booking_id]);
  if (b && ['telegram', 'mini'].includes(b.channel) && b.status === 'held' && b.expires_at > at) {   // on the site the reason is on screen
    await notify(q, fx, ctx, { template: 'payment_failed', audience: 'client', clientId: b.client_id,
      vars: { reason, apt: b.apartment_no, holdUntil: iso(b.expires_at), link: bookingPath(b, ctx.env) },
      eventId: ev, dedupeKey: `payment_failed:${p.id}` });
  }
  return row;
}

// reason — a key of 05 §9: bank_declined, insufficient_funds, code_attempts_exceeded, session_expired, hold_expired, provider_error.
export const markFailed = (q, fx, ctx, { paymentId, reason, details, actor }) =>
  closePayment(q, fx, ctx, { paymentId, status: 'failed', reason, details, actor });

// why — cancelled_by_user, replaced, hold_expired, booking_closed, session_expired.
export const cancelPayment = (q, fx, ctx, { paymentId, why, actor }) =>
  closePayment(q, fx, ctx, { paymentId, status: 'cancelled', reason: why, actor });

// 05 §7.3: every open payment of the booking is cancelled now; Stripe also gets payment.reconcile, which expires the
// session or, if it was paid meanwhile, takes the money as a late payment. → how many were closed.
export async function closeOpenPayments(q, fx, ctx, { bookingId = null, orderId = null, why }) {
  const open = await q.query(`SELECT id, provider FROM payments
    WHERE status IN ('pending', 'processing') AND (booking_id = $1 OR order_id = $2) ORDER BY created_at`, [bookingId, orderId]);
  const at = ctx.now();
  for (const p of open) {
    await cancelPayment(q, fx, ctx, { paymentId: p.id, why });
    if (p.provider === 'stripe') await later(q, fx, ctx, 'payment.reconcile', at, { paymentId: p.id }, `payment.reconcile:${p.id}`);
  }
  return open.length;
}

// GET /api/payments/:id (05 §12): what the payment page shows, the reason text in the page's language (FR-PAY-07).
export async function paymentView(q, id, lang = 'ru', opts = {}) {
  const ctx = context(opts);
  const p = await q.one('SELECT * FROM payments WHERE id = $1', [id]);
  if (!p) throw new DomainError('payment_not_found');
  const tg = await targetOf(q, p, ctx.now(), ctx.env);
  return {
    code: p.code, provider: p.provider, status: p.status, failureReason: p.failure_reason,
    failureText: failureText(p.failure_reason, lang), amount: Number(p.amount), expiresAt: p.expires_at && iso(p.expires_at),
    cardBrand: p.card_brand, cardMask: p.card_mask,
    target: tg.row ? { type: tg.type, no: tg.row.no, status: tg.status, link: tg.link } : null
  };
}

// Job handlers (04 §6.1). fx — shared with the other handlers of the run: what they leave goes out after it.
export function paymentJobHandlers(opts = {}, fx = { outbox: [], jobs: [] }) {
  const handlers = {
    // An open payment of a closed booking, a stale open payment (daily), a Stripe payment cancelled by us.
    'payment.reconcile': async (job, { q, now }) => {
      const ctx = context({ ...opts, now });
      const p = await q.one('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [job.payload.paymentId]);
      const stripeClosed = p?.provider === 'stripe' && p.status === 'cancelled';
      if (!p || (!OPEN.includes(p.status) && !stripeClosed)) return 'skipped';
      const tg = await targetOf(q, p, now(), ctx.env);
      const status = tg.type === 'booking' ? tg.status : null;
      if (OPEN.includes(p.status) && tg.live) return 'skipped';                               // the hold is alive: nothing to close
      if (p.provider === 'stripe') {
        const provider = await getProvider('stripe', ctx);
        if (await provider.close(p) === 'paid') {
          const { refs = {} } = await provider.inspect(p);
          await markSucceeded(q, fx, ctx, { paymentId: p.id, ...refs });
          return 'done';
        }
        if (stripeClosed) return 'done';
      }
      await cancelPayment(q, fx, ctx, { paymentId: p.id, why: status === 'hold_expired' ? 'hold_expired' : tg.type === 'order' ? 'session_expired' : 'booking_closed' });
      return 'done';
    }
  };
  return { handlers, fx };
}
