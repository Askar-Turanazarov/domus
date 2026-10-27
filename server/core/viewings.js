// Viewing bookings: the checks here, the saving in the base (server/db/legacy.js addBooking → viewings).
// Times are Tashkent time, stored as "YYYY-MM-DDTHH:MM+05:00". A booking never changes the apartment status.
import crypto from 'node:crypto';
import { ruText } from '../tools/logText.js';
import { PHONE } from '../validateOrder.js';
import { now as clockNow } from './clock.js';

export { PHONE };

const TZ = '+05:00';
const TZ_MS = 5 * 3600e3;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})?$/;   // to the minute: a slot is a minute

// "2026-10-25T15:00" (Tashkent) or with an offset → { ms, local } | null. Pure.
export function parseTime(s) {
  if (!ISO.test(s)) return null;
  const ms = Date.parse(/(Z|[+-]\d{2}:\d{2})$/.test(s) ? s : s + TZ);
  if (Number.isNaN(ms)) return null;
  return { ms, local: new Date(ms + TZ_MS).toISOString().slice(0, 16) + TZ };
}

// key / vars — the same text in all three languages for the call log (logText.js).
export class BookingError extends Error {
  constructor(key, vars = {}) {
    super(ruText(key, vars));
    this.key = key;
    this.vars = vars;
  }
}

// addBooking(b) → b | null (the slot is taken). → the saved booking; throws BookingError when the apartment is unknown
// or sold, the time is past or the slot is taken.
export async function bookViewing(addBooking, apartments, { name, phone, datetime, no }, now = clockNow().getTime()) {
  const a = apartments.find(x => x.no === no);
  if (!a) throw new BookingError('notFound', { no, hint: true });
  if (a.status === 'sold') throw new BookingError('sold', { no });
  if (!PHONE.test(phone)) throw new BookingError('phone');
  const t = parseTime(datetime);
  if (!t) throw new BookingError('dateFormat');
  if (t.ms <= now) throw new BookingError('past');
  const b = { id: crypto.randomUUID(), no, name: name.trim(), phone: phone.trim(), datetime: t.local, createdAt: new Date(now).toISOString() };
  if (!(await addBooking(b))) throw new BookingError('taken', { no, when: t.local.slice(0, 16).replace('T', ' ') });
  return b;
}
