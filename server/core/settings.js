// Business settings (01 §10, 02 §3.1): the settings table over the defaults, cached for 15 s per function instance.
// A change applies to new holds and bookings only. FR-ADM-08: the head changes them; the event comes with §04 (day 2).
import { DEFAULT_SETTINGS } from './defaults.js';
import { now as clockNow } from './clock.js';

export class SettingError extends Error {
  constructor(key) { super(`err:setting_invalid:${key}`); this.code = 'setting_invalid'; this.key = key; }
}

const int = (lo, hi, step = 1) => v => Number.isInteger(v) && v >= lo && v <= hi && v % step === 0;
const obj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
// The checks on save (02 §3.1).
const CHECK = {
  deposit_amount: int(1_000_000, 100_000_000, 1000),
  hold_minutes: int(5, 60),
  booking_hours: int(24, 336),
  max_active_bookings: int(1, 5),
  installment: v => obj(v) && int(10, 90)(v.minDownPct) && Array.isArray(v.terms) && v.terms.length >= 1 && v.terms.length <= 4
    && v.terms.every(t => obj(t) && int(3, 60)(t.months) && typeof t.markupPct === 'number' && t.markupPct >= 0 && t.markupPct <= 50),
  furniture_prepay_pct: int(10, 100),
  reminders: v => obj(v) && Array.isArray(v.bookingHoursBefore) && v.bookingHoursBefore.length <= 4
    && [...v.bookingHoursBefore, v.viewingHoursBefore].every(int(1, 48)),
  extend_max_hours: int(1, 168),
  chat_limits: v => obj(v) && ['perMinute', 'perDay', 'perConversation'].every(k => int(1, 1000)(v[k])),
  offer_version: v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v),
  ai: v => obj(v) && typeof v.geminiDisabled === 'boolean' && typeof v.primaryDisabled === 'boolean' && ['free', 'paid'].includes(v.geminiTier),
  bank_requisites: v => obj(v) && Object.values(v).every(x => typeof x === 'string' && x.length <= 200)
};

export const validSetting = (key, value) => Boolean(CHECK[key]?.(value));

// db — the base (or an open transaction); now — the clock.
export function createSettings(db, { now = clockNow, ttlMs = 15_000 } = {}) {
  let cache = null, until = 0;
  async function get(key) {
    if (!cache || now().getTime() >= until) {
      const rows = await db.query('SELECT key, value FROM settings');
      cache = { ...DEFAULT_SETTINGS, ...Object.fromEntries(rows.filter(r => r.key in DEFAULT_SETTINGS).map(r => [r.key, r.value])) };
      until = now().getTime() + ttlMs;
    }
    return key === undefined ? cache : cache[key];
  }
  // actor — { type, id, role, channel } (01 §3.2); a staff id goes to updated_by.
  async function set(key, value, actor = null) {
    if (!validSetting(key, value)) throw new SettingError(key);
    await db.query(`INSERT INTO settings (key, value, updated_at, updated_by) VALUES ($1, $2, $3, $4)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
      [key, JSON.stringify(value), now(), actor?.type === 'staff' ? actor.id : null]);
    cache = null;
    return value;
  }
  return { get, set, drop: () => { cache = null; } };
}
