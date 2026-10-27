// Apartments (03 §2, §8): the status is computed from the bookings at every read (D-15, BR-07); sale and its undoing.
import { DomainError, need, staffIdOf, reasonOf } from './errors.js';
import { emit } from './events.js';
import { cancel as cancelJobs } from './jobs.js';
import { context, inTx, notify } from './tx.js';

// 02 §3.3: an expired but not yet swept booking no longer holds the apartment.
const WITH_STATUS = `
  SELECT a.*, CASE WHEN a.sold_at IS NOT NULL THEN 'sold'
                   WHEN b.status = 'held'   THEN 'held'
                   WHEN b.status = 'booked' THEN 'booked'
                   ELSE 'free' END AS status,
         b.id AS booking_id, b.no AS booking_no, b.client_id AS booking_client_id, b.expires_at AS booking_expires_at
    FROM apartments a
    LEFT JOIN bookings b ON b.apartment_no = a.no AND b.status IN ('held', 'booked') AND b.expires_at > $1`;

// filter — { rooms?, floorMin?, floorMax?, priceMin?, priceMax?, areaMin?, areaMax?, building?, status? } → apartments
// with status, by number.
export async function listApartments(q, filter = {}, { now } = context()) {
  const rows = await q.query(`${WITH_STATUS} ORDER BY a.no`, [now()]);
  const f = filter;
  return rows.filter(a => (f.rooms == null || a.rooms === f.rooms)
    && (f.floorMin == null || a.floor >= f.floorMin) && (f.floorMax == null || a.floor <= f.floorMax)
    && (f.priceMin == null || a.price >= f.priceMin) && (f.priceMax == null || a.price <= f.priceMax)
    && (f.areaMin == null || a.area >= f.areaMin) && (f.areaMax == null || a.area <= f.areaMax)
    && (f.building == null || a.building === f.building) && (f.status == null || a.status === f.status));
}

export async function getApartment(q, no, { now } = context()) {
  return q.one(`${WITH_STATUS} WHERE a.no = $2`, [now(), no]);
}

// The showcase map (03 §2): { no: 'free' | 'held' | 'booked' | 'sold' } — no client, no deadline.
export async function statusMap(q, { now } = context()) {
  const rows = await q.query(`${WITH_STATUS} ORDER BY a.no`, [now()]);
  return Object.fromEntries(rows.map(r => [r.no, r.status]));
}

const staffName = async (q, actor) => (staffIdOf(actor) && (await q.one('SELECT name FROM staff WHERE id = $1', [actor.id]))?.name) || '';

// T9 (03 §8): booked → the booking becomes converted; free → an office sale; held → err:apartment_held.
// expectedVersion — the apartment's version from the screen. → the apartment after the sale.
export async function markSold(db, { apartmentNo, note = null, expectedVersion }, actor, opts = {}) {
  need(actor, 'manager', 'head');
  const ctx = context(opts);
  return inTx(db, ctx, async (q, fx) => {
    const at = ctx.now();
    const apt = await q.one('SELECT * FROM apartments WHERE no = $1 FOR UPDATE', [apartmentNo]);
    if (!apt) throw new DomainError('apartment_not_found', { no: apartmentNo });
    if (apt.sold_at) throw new DomainError('apartment_sold', { no: apartmentNo });
    if (expectedVersion != null && expectedVersion !== apt.version) throw new DomainError('stale');
    const b = await q.one(`SELECT * FROM bookings WHERE apartment_no = $1 AND status IN ('held', 'booked') AND expires_at > $2 FOR UPDATE`,
      [apartmentNo, at]);
    if (b?.status === 'held') throw new DomainError('apartment_held', { no: apartmentNo });
    if (b) {
      await q.query(`UPDATE bookings SET status = 'converted', closed_at = $2, updated_at = $2, version = version + 1 WHERE id = $1`, [b.id, at]);
      for (const type of ['booking.remind', 'booking.expire']) await cancelJobs(q, { type, bookingId: b.id }, ctx);
    }
    const sold = await q.one(`UPDATE apartments SET sold_at = $2, sold_booking_id = $3, sold_by = $4, sold_note = $5, updated_at = $2,
      version = version + 1 WHERE no = $1 RETURNING *`, [apartmentNo, at, b?.id ?? null, JSON.stringify(actor), note]);
    const ev = await emit(q, 'apartment.sold', { apartmentNo, bookingId: b?.id, clientId: b?.client_id, staffId: staffIdOf(actor) },
      { price: apt.price, viaBooking: Boolean(b) }, actor, ctx);
    if (b) await notify(q, fx, ctx, { template: 'apartment_sold', audience: 'client', clientId: b.client_id, vars: { apt: apartmentNo },
      eventId: ev, dedupeKey: `apartment_sold:${b.id}` });
    await notify(q, fx, ctx, { template: 'staff_apartment_sold', audience: 'staff_group',
      vars: { apt: apartmentNo, staffName: await staffName(q, actor) }, eventId: ev, dedupeKey: `staff_apartment_sold:${apartmentNo}:${sold.version}` });
    return { ...sold, status: 'sold' };
  });
}

// Undo a sale made by mistake (03 §8): head only, reason required. The converted booking stays converted.
export async function unsell(db, { apartmentNo, reason }, actor, opts = {}) {
  need(actor, 'head');
  const why = reasonOf(reason);
  const ctx = context(opts);
  return inTx(db, ctx, async (q, fx) => {
    const at = ctx.now();
    const apt = await q.one('SELECT * FROM apartments WHERE no = $1 FOR UPDATE', [apartmentNo]);
    if (!apt) throw new DomainError('apartment_not_found', { no: apartmentNo });
    if (!apt.sold_at) throw new DomainError('invalid_input');
    const row = await q.one(`UPDATE apartments SET sold_at = NULL, sold_booking_id = NULL, sold_by = NULL, sold_note = NULL,
      updated_at = $2, version = version + 1 WHERE no = $1 RETURNING *`, [apartmentNo, at]);
    const ev = await emit(q, 'apartment.unsold', { apartmentNo, staffId: staffIdOf(actor) }, { reason: why }, actor, ctx);
    await notify(q, fx, ctx, { template: 'staff_apartment_unsold', audience: 'staff_group',
      vars: { apt: apartmentNo, staffName: await staffName(q, actor), reason: why }, eventId: ev,
      dedupeKey: `staff_apartment_unsold:${apartmentNo}:${row.version}` });
    return { ...row, status: 'free' };
  });
}
