// Rows for core tests (15 §2.3): clients, staff and bookings straight in the base, times from the clock.
import { now } from '../../server/core/clock.js';

export async function makeClient(db, { name = 'Аня', phone = null, verified = false, tg = null, chat = null, lang = 'ru', channel = 'web' } = {}) {
  return db.one(`INSERT INTO clients (name, phone, phone_verified, telegram_user_id, telegram_chat_id, lang, channels, first_channel, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, ARRAY[$7], $7, $8, $8) RETURNING *`, [name, phone, verified, tg, chat, lang, channel, now()]);
}

export async function makeStaff(db, { login = 'aziz', name = 'Азиз', role = 'manager', tg = null } = {}) {
  return db.one(`INSERT INTO staff (login, name, role, password_hash, telegram_user_id, created_at)
    VALUES ($1, $2, $3, 'x', $4, $5) RETURNING *`, [login, name, role, tg, now()]);
}

// status 'held' | 'booked' | …; minutes — until expires_at (negative = already past).
export async function makeBooking(db, { apartmentNo = 41, clientId, status = 'held', minutes = 15 } = {}) {
  const at = now();
  const apt = await db.one('SELECT price FROM apartments WHERE no = $1', [apartmentNo]);
  return db.one(`INSERT INTO bookings (apartment_no, client_id, status, channel, created_by, expires_at, held_at, booked_at,
      deposit_amount, price_at_booking, updated_at)
    VALUES ($1, $2, $3, 'web', '{"type":"client"}', $4, $5, $6, 10000000, $7, $5) RETURNING *`,
    [apartmentNo, clientId, status, new Date(at.getTime() + minutes * 60e3), at,
      ['booked', 'expired', 'converted'].includes(status) ? at : null, apt.price]);
}

export const asStaff = (s, role = s.role) => ({ type: 'staff', id: s.id, role, channel: 'admin' });
export const asClient = (c, channel = 'web') => ({ type: 'client', id: c.id, role: 'client', channel });
export const SYSTEM = { type: 'system', id: null, role: 'system', channel: 'system' };
