// Refunds (05 §8, BR-11, BR-12, BR-14, BR-17): the payment leaves revenue at once (refund_due), the money goes back in
// the refund.process job; the result — applyRefundResult, from the job or the Stripe webhook, whichever comes first.
import { DomainError, need, reasonOf } from './errors.js';
import { emit } from './events.js';
import { context, inTx, later, notify } from './tx.js';
import { toMs } from './clock.js';
import { getProvider } from '../payments/index.js';

const SYSTEM = { type: 'system', id: null, role: 'system', channel: 'system' };
const CHECK_MS = toMs('1m');                           // a pending Stripe refund is looked at again in a minute…
const MAX_CHECKS = 10;                                 // …up to 10 times (§8.2)

const refsOf = p => ({ paymentId: p.id, bookingId: p.booking_id, clientId: p.client_id, orderId: p.order_id });

// Inside the caller's transaction. reason — developer_cancel | late_payment | duplicate_payment | manual. → the refunds row.
export async function requestRefund(q, fx, ctx, { paymentId, reason, note = null, actor = SYSTEM }) {
  const at = ctx.now();
  const p = await q.one('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId]);
  if (!p || !['succeeded', 'refund_due'].includes(p.status)) throw new DomainError('refund_not_allowed');
  if (await q.one(`SELECT id FROM refunds WHERE payment_id = $1 AND status IN ('pending', 'succeeded')`, [paymentId])) {
    throw new DomainError('refund_in_progress');
  }
  const r = await q.one(`INSERT INTO refunds (payment_id, amount, reason, note, status, requested_by, created_at, updated_at)
    VALUES ($1, $2, $3, $4, 'pending', $5, $6, $6) RETURNING *`, [paymentId, p.amount, reason, note, JSON.stringify(actor), at]);
  await q.query(`UPDATE payments SET status = 'refund_due', updated_at = $2, version = version + 1 WHERE id = $1`, [paymentId, at]);
  await emit(q, 'refund.requested', refsOf(p), { amount: p.amount, reason }, actor, ctx);
  await later(q, fx, ctx, 'refund.process', at, { refundId: r.id }, `refund.process:${r.id}`);
  return r;
}

// 05 §8.3. status — succeeded | failed | pending; details — { providerRef?, error? }. A refund already final is left as
// it is (the second of job and webhook). → the refunds row | null.
export async function applyRefundResult(q, fx, ctx, refundId, status, details = {}) {
  const at = ctx.now();
  const r = await q.one('SELECT * FROM refunds WHERE id = $1 FOR UPDATE', [refundId]);
  if (!r || r.status !== 'pending') return null;
  const ref = details.providerRef ?? null;
  if (status === 'pending') {
    return q.one('UPDATE refunds SET provider_ref = COALESCE($2, provider_ref), updated_at = $3 WHERE id = $1 RETURNING *', [r.id, ref, at]);
  }
  const p = await q.one('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [r.payment_id]);
  if (status === 'failed') {
    const row = await q.one(`UPDATE refunds SET status = 'failed', failure = $2, provider_ref = COALESCE($3, provider_ref), updated_at = $4
      WHERE id = $1 RETURNING *`, [r.id, String(details.error ?? 'failed').slice(0, 300), ref, at]);
    await emit(q, 'refund.failed', { paymentId: p.id }, { error: row.failure }, SYSTEM, ctx);   // the payment stays refund_due
    return row;
  }
  const row = await q.one(`UPDATE refunds SET status = 'succeeded', provider_ref = COALESCE($2, provider_ref), completed_at = $3,
    updated_at = $3 WHERE id = $1 RETURNING *`, [r.id, ref, at]);
  await q.query(`UPDATE payments SET status = 'refunded', updated_at = $2, version = version + 1 WHERE id = $1`, [p.id, at]);
  const ev = await emit(q, 'refund.succeeded', refsOf(p), { reason: r.reason, amount: r.amount, provider: p.provider }, SYSTEM, ctx);
  const b = p.booking_id && await q.one('SELECT no FROM bookings WHERE id = $1', [p.booking_id]);
  const vars = { amount: r.amount, bookingNo: b?.no ?? null };
  await notify(q, fx, ctx, { template: 'refund_done', audience: 'client', clientId: p.client_id, vars,
    eventId: ev, dedupeKey: `refund_done:${r.id}` });
  await notify(q, fx, ctx, { template: 'staff_refund_done', audience: 'staff_group', vars: { ...vars, reason: r.reason },
    eventId: ev, dedupeKey: `staff_refund_done:${r.id}` });
  return row;
}

// 03 §7.3 (BR-14): only the head; a succeeded deposit whose booking closed without the deposit coming back by the rules —
// expired, or cancelled by the client. The reason is required. → { refundId }.
export async function refundManual(db, { paymentId, reason }, actor, opts = {}) {
  need(actor, 'head');
  const why = reasonOf(reason);
  const ctx = context(opts);
  return inTx(db, ctx, async (q, fx) => {
    const p = await q.one('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId]);
    if (!p) throw new DomainError('payment_not_found');
    const b = p.booking_id && await q.one('SELECT status, cancel_initiator FROM bookings WHERE id = $1', [p.booking_id]);
    const closed = b && (b.status === 'expired' || (b.status === 'cancelled' && b.cancel_initiator === 'client'));
    if (p.kind !== 'deposit' || p.status !== 'succeeded' || !closed) throw new DomainError('refund_not_allowed');
    const r = await requestRefund(q, fx, ctx, { paymentId: p.id, reason: 'manual', note: why, actor });
    return { refundId: r.id };
  });
}

// «Повторить возврат» (05 §8.3): the head makes a new refund after a failed one; the payment is still refund_due.
export async function retryRefund(db, { refundId }, actor, opts = {}) {
  need(actor, 'head');
  const ctx = context(opts);
  return inTx(db, ctx, async (q, fx) => {
    const old = await q.one('SELECT * FROM refunds WHERE id = $1', [refundId]);
    if (!old) throw new DomainError('refund_not_allowed');
    if (old.status !== 'failed') throw new DomainError(old.status === 'pending' ? 'refund_in_progress' : 'refund_not_allowed');
    const r = await requestRefund(q, fx, ctx, { paymentId: old.payment_id, reason: old.reason, note: old.note, actor });
    return { refundId: r.id };
  });
}

// Job handlers (05 §8.2). A network failure throws: the job is repeated by the schedule of 04 §6.
export function refundJobHandlers(opts = {}, fx = { outbox: [], jobs: [] }) {
  const handlers = {
    'refund.process': async (job, { q, now }) => {
      const ctx = context({ ...opts, now });
      const r = await q.one('SELECT * FROM refunds WHERE id = $1 FOR UPDATE', [job.payload.refundId]);
      if (!r || r.status !== 'pending') return 'skipped';
      const p = await q.one('SELECT * FROM payments WHERE id = $1', [r.payment_id]);
      const provider = await getProvider(p.provider, ctx);
      const out = await provider.refund(p, r);
      await applyRefundResult(q, fx, ctx, r.id, out.status, { providerRef: out.providerRef, error: out.error });
      if (out.status === 'pending') {
        const n = (job.payload.check ?? 0) + 1;
        if (n <= MAX_CHECKS) {
          await later(q, fx, ctx, 'refund.process', new Date(now().getTime() + CHECK_MS), { refundId: r.id, check: n },
            `refund.process:${r.id}:${n}`);
        } else console.error('refund still pending after the checks:', r.id);
      }
      return 'done';
    }
  };
  return { handlers, fx };
}
