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
import { getProvider } from '../payments/index.js';
import { failureText } from '../i18n/index.js';

export const OPEN = ['pending', 'processing'];
const PAID = ['succeeded', 'refund_due', 'refunded'];
const CODE_ABC = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';   // no look-alike letters (02 §3.6)
const MIN_LEFT_MS = 60e3;                             // less left of the hold — the payment would almost surely be late
const SYSTEM = { type: 'system', id: null, role: 'system', channel: 'system' };
const iso = d => new Date(d).toISOString();

const newCode = () => `P-${Array.from({ length: 4 }, () => CODE_ABC[crypto.randomInt(CODE_ABC.length)]).join('')}`;
const refsOf = p => ({ paymentId: p.id, bookingId: p.booking_id, orderId: p.order_id, clientId: p.client_id });

async function lockPayment(q, id) {
  const p = await q.one('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [id]);
  if (!p) throw new DomainError('payment_not_found');
  return p;
}

// startPayment (05 §3): input — { target: {bookingId}, provider, consent: {version} | null, lang, idempotencyKey }.
// Phase A — one transaction; phase B — provider.begin after COMMIT. → { paymentId, code, url }.
export async function startPayment(db, input, actor, opts = {}) {
  const { target = {}, provider: providerId, consent = null, lang = 'ru', idempotencyKey = null } = input;
  if (!target.bookingId) throw new DomainError('invalid_input');   // order prepayment (05 §3.3) comes with furniture orders
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
    await sweepExpired(q, fx, ctx, { bookingId: target.bookingId });                           // 2
    const b = await q.one('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [target.bookingId]);
    if (!b) throw new DomainError('booking_not_found');
    if (actor?.type === 'client' && actor.id && actor.id !== b.client_id) throw new DomainError('forbidden');
    if (b.status === 'booked') throw new DomainError('booking_already_paid');
    if (b.status !== 'held') throw new DomainError('booking_closed');
    const left = b.expires_at.getTime() - at.getTime();                                         // 3
    if (left < MIN_LEFT_MS) throw new DomainError('hold_expiring', { n: Math.max(0, Math.round(left / 1000)) });
    const s = await settingsOf(q, ctx);                                                         // 4
    if (b.consent_version !== s.offer_version) {
      if (consent?.version !== s.offer_version) throw new DomainError('consent_required');
      await q.query('UPDATE bookings SET consent_version = $2, consent_at = $3, updated_at = $3 WHERE id = $1', [b.id, s.offer_version, at]);
    }
    if (!provider?.enabled()) throw new DomainError('provider_unavailable');                   // 5
    await closeOpenPayments(q, fx, ctx, { bookingId: b.id, why: 'replaced' });                  // 6
    const { currency, providerAmount } = provider.money(Number(b.deposit_amount));
    let p = null;
    for (let i = 0; !p && i < 5; i++) {                                                         // 7
      p = await q.one(`INSERT INTO payments (code, kind, booking_id, client_id, provider, amount, currency, provider_amount,
          status, expires_at, created_by, created_at, updated_at)
        VALUES ($1, 'deposit', $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10, $10)
        ON CONFLICT (code) DO NOTHING RETURNING *`,
      [newCode(), b.id, b.client_id, provider.id, b.deposit_amount, currency, providerAmount, b.expires_at, JSON.stringify(actor), at]);
    }
    if (!p) throw new Error('no free payment code');
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
    const booking = await db.one('SELECT no, apartment_no FROM bookings WHERE id = $1', [payment.booking_id]);  // Stripe names the line
    begun = await provider.begin(payment, { lang, origin: ctx.env.PUBLIC_URL ?? '', booking });
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
// → { result: 'booked' | 'late' | 'duplicate' | 'already' | 'invalid', payment }.
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
  if (p.kind !== 'deposit') throw new DomainError('invalid_input');                              // orders.confirmPrepaid — with the orders
  const result = await confirmPaid(q, fx, ctx, { bookingId: p.booking_id, payment: p, late });   // 4
  const ok = result === 'booked';
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
  const b = p.booking_id && await q.one('SELECT * FROM bookings WHERE id = $1', [p.booking_id]);
  return {
    code: p.code, provider: p.provider, status: p.status, failureReason: p.failure_reason,
    failureText: failureText(p.failure_reason, lang), amount: Number(p.amount), expiresAt: p.expires_at && iso(p.expires_at),
    cardBrand: p.card_brand, cardMask: p.card_mask,
    target: b ? { type: 'booking', no: b.no, status: effectiveStatus(b, ctx.now()), link: bookingPath(b, ctx.env) } : null
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
      const b = p.booking_id && await q.one('SELECT * FROM bookings WHERE id = $1', [p.booking_id]);
      const status = b ? effectiveStatus(b, now()) : null;
      if (OPEN.includes(p.status) && status === 'held') return 'skipped';                     // the hold is alive: nothing to close
      if (p.provider === 'stripe') {
        const provider = await getProvider('stripe', ctx);
        if (await provider.close(p) === 'paid') {
          const { refs = {} } = await provider.inspect(p);
          await markSucceeded(q, fx, ctx, { paymentId: p.id, ...refs });
          return 'done';
        }
        if (stripeClosed) return 'done';
      }
      await cancelPayment(q, fx, ctx, { paymentId: p.id, why: status === 'hold_expired' ? 'hold_expired' : 'booking_closed' });
      return 'done';
    }
  };
  return { handlers, fx };
}
