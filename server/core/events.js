// Core events (04 §2): one row per fact, written in the same transaction as the change. data holds no names or phones.
import { now as clockNow } from './clock.js';

// Types shown in the live dashboard feed (04 §2 «Лента», FR-DSH-04).
export const FEED_TYPES = new Set([
  'booking.held', 'booking.hold_expired', 'booking.paid', 'booking.extended', 'booking.extend_requested', 'booking.expired',
  'booking.cancelled', 'apartment.sold', 'apartment.unsold', 'payment.failed', 'payment.late', 'refund.succeeded',
  'refund.failed', 'client.assigned', 'client.handoff_requested', 'viewing.created', 'order.created', 'order.prepaid',
  'order.stage_changed', 'demo.time_shifted'
]);

const REFS = { apartmentNo: 'apartment_no', bookingId: 'booking_id', paymentId: 'payment_id', clientId: 'client_id',
  viewingId: 'viewing_id', orderId: 'order_id', staffId: 'staff_id' };

// q — the base or an open transaction; refs — { bookingId, apartmentNo, … }; actor — { type, id?, role?, channel? } (01 §3.2).
// → the event id.
export async function emit(q, type, refs = {}, data = {}, actor = { type: 'system' }, { now = clockNow, requestId = null } = {}) {
  const cols = Object.keys(REFS).filter(k => refs[k] != null);
  const params = [now(), type, JSON.stringify(actor), JSON.stringify(data), requestId, ...cols.map(k => refs[k])];
  const row = await q.one(
    `INSERT INTO events (at, type, actor, data, request_id${cols.map(k => ', ' + REFS[k]).join('')})
     VALUES ($1, $2, $3, $4, $5${cols.map((_, i) => ', $' + (i + 6)).join('')}) RETURNING id`, params);
  return row.id;
}

// The dashboard feed (04 §8): feed events after the cursor, plus every feed event of the last 15 s whatever its id —
// a long transaction may commit a lower id after a higher one was shown. Newest first; the browser drops repeats by id.
export async function feed(q, { after = 0, limit = 50, now = clockNow } = {}) {
  return q.query(
    `SELECT * FROM events WHERE type = ANY($1) AND (id > $2 OR at > $3) ORDER BY id DESC LIMIT $4`,
    [[...FEED_TYPES], after, new Date(now().getTime() - 15_000), limit]);
}

// A booking's history (FR-BKG-12): its events and those of its payments, in time order.
export async function history(q, { bookingId }) {
  return q.query(
    `SELECT * FROM events WHERE booking_id = $1
        OR payment_id IN (SELECT id FROM payments WHERE booking_id = $1)
      ORDER BY at, id`, [bookingId]);
}
