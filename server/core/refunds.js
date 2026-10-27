// Refund requests (05 §8.1): the payment leaves revenue at once (refund_due), the money goes back in the refund.process job.
import { DomainError } from './errors.js';
import { emit } from './events.js';
import { later } from './tx.js';

// Inside the caller's transaction. reason — developer_cancel | late_payment | duplicate_payment | manual. → the refunds row.
export async function requestRefund(q, fx, ctx, { paymentId, reason, note = null, actor = { type: 'system' } }) {
  const at = ctx.now();
  const p = await q.one('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId]);
  if (!p || !['succeeded', 'refund_due'].includes(p.status)) throw new DomainError('refund_not_allowed');
  if (await q.one(`SELECT id FROM refunds WHERE payment_id = $1 AND status IN ('pending', 'succeeded')`, [paymentId])) {
    throw new DomainError('refund_in_progress');
  }
  const r = await q.one(`INSERT INTO refunds (payment_id, amount, reason, note, status, requested_by, created_at, updated_at)
    VALUES ($1, $2, $3, $4, 'pending', $5, $6, $6) RETURNING *`, [paymentId, p.amount, reason, note, JSON.stringify(actor), at]);
  await q.query(`UPDATE payments SET status = 'refund_due', updated_at = $2, version = version + 1 WHERE id = $1`, [paymentId, at]);
  await emit(q, 'refund.requested', { paymentId, bookingId: p.booking_id, clientId: p.client_id, orderId: p.order_id },
    { amount: p.amount, reason }, actor, ctx);
  await later(q, fx, ctx, 'refund.process', at, { refundId: r.id }, `refund.process:${r.id}`);
  return r;
}
