// Read models of the admin (12 §3): the board of all apartments and the apartment card. No changes here — those go through
// the core (bookings.js, apartments.js); personal data leaves only as masks (NFR-PRIV-02).
import { need } from './errors.js';
import { maskPhone } from './phone.js';
import { context } from './tx.js';
import { getApartment, listApartments } from './apartments.js';

export const SOON_MS = 24 * 3600e3;                         // «burns within 24 h» (12 §3)
const ROLES = ['manager', 'head'];

// → [{ no, floor, rooms, area, price, status, bookingNo?, expiresAt?, soon }] by number.
export async function unitsBoard(q, actor, opts = {}) {
  need(actor, ...ROLES);
  const { now } = context(opts);
  const at = now().getTime();
  const rows = await listApartments(q, {}, { now });
  return rows.map(a => {
    const open = a.status === 'held' || a.status === 'booked';
    const ms = open ? new Date(a.booking_expires_at).getTime() : null;
    return {
      no: a.no, floor: a.floor, rooms: a.rooms, area: Number(a.area), price: Number(a.price), status: a.status,
      ...(open ? { bookingNo: a.booking_no, expiresAt: new Date(a.booking_expires_at).toISOString() } : {}),
      soon: a.status === 'booked' && ms - at < SOON_MS
    };
  });
}

const clientOf = c => c && ({ id: c.id, name: c.name, phone: maskPhone(c.phone), telegramLinked: c.telegram_user_id != null });

// The apartment, the booking that holds it now, all its bookings and viewings, and its events (newest first, 60).
// → null when there is no such apartment.
export async function apartmentCard(q, no, actor, opts = {}) {
  need(actor, ...ROLES);
  const { now } = context(opts);
  const a = await getApartment(q, no, { now });
  if (!a) return null;
  const bookings = await q.query(
    `SELECT b.*, c.id AS c_id, c.name AS c_name, c.phone AS c_phone, c.telegram_user_id AS c_tg
       FROM bookings b JOIN clients c ON c.id = b.client_id WHERE b.apartment_no = $1 ORDER BY b.held_at DESC, b.no DESC LIMIT 50`, [no]);
  const viewings = await q.query(
    `SELECT v.id, v.at, v.status, v.channel, v.name, v.phone FROM viewings v WHERE v.apartment_no = $1 ORDER BY v.at DESC LIMIT 30`, [no]);
  const events = await q.query(
    `SELECT e.id, e.at, e.type, e.actor, e.booking_id, e.data, s.name AS staff_name
       FROM events e LEFT JOIN staff s ON s.id = e.staff_id WHERE e.apartment_no = $1 ORDER BY e.at DESC, e.id DESC LIMIT 60`, [no]);
  const shape = b => ({
    no: b.no, status: b.status, channel: b.channel, heldAt: b.held_at, bookedAt: b.booked_at, closedAt: b.closed_at,
    expiresAt: b.expires_at, deposit: Number(b.deposit_amount), price: Number(b.price_at_booking),
    cancelInitiator: b.cancel_initiator, cancelReason: b.cancel_reason, version: b.version,
    client: clientOf({ id: b.c_id, name: b.c_name, phone: b.c_phone, telegram_user_id: b.c_tg })
  });
  const all = bookings.map(shape);
  const noOf = Object.fromEntries(bookings.map(b => [b.id, b.no]));
  const current = a.booking_no == null ? null : all.find(b => b.no === a.booking_no) ?? null;
  return {
    apartment: {
      no: a.no, building: a.building, floor: a.floor, rooms: a.rooms, area: Number(a.area), price: Number(a.price),
      status: a.status, version: a.version, soldAt: a.sold_at, soldNote: a.sold_note
    },
    booking: current,
    bookings: all,
    viewings: viewings.map(v => ({ id: v.id, at: v.at, status: v.status, channel: v.channel, name: v.name, phone: maskPhone(v.phone) })),
    history: events.map(e => ({ id: Number(e.id), at: e.at, type: e.type, actor: e.actor?.type ?? 'system', staff: e.staff_name ?? null,
      bookingNo: noOf[e.booking_id] ?? null, data: e.data }))
  };
}
