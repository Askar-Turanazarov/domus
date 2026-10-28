// The signature of Telegram.WebApp.initData (10 §7.2, FR-MINI-02, NFR-SEC-02): the mini app sends it in X-Tg-Init-Data
// on every /api/mini/* request. Wrong, old or unsigned → err:tg_auth_failed (401); the client comes from `user` (R1).
import crypto from 'node:crypto';
import { now as clockNow } from '../core/clock.js';
import { DomainError } from '../core/errors.js';

export const MAX_AGE_S = 24 * 3600;
const CACHE_MS = 5 * 60e3;
const MAX_LEN = 4096;

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// The check string of steps 1–2: every pair but `hash`, sorted by key, `key=value` joined by \n.
export function checkString(params) {
  return [...params].filter(([k]) => k !== 'hash').sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
}

// For tests and the local mini app: initData signed with the token, as Telegram would.
export function signInitData(fields, token) {
  const p = new URLSearchParams(Object.entries(fields).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  const secret = hmac('WebAppData', token);
  p.set('hash', hmac(secret, checkString(p)).toString('hex'));
  return p.toString();
}

// → { user: {id, first_name, last_name?, username?, language_code?}, authDate, hash } or throws err:tg_auth_failed.
export function verifyInitData(raw, token, { now = clockNow } = {}) {
  const fail = () => { throw new DomainError('tg_auth_failed'); };
  if (!token || typeof raw !== 'string' || !raw || raw.length > MAX_LEN) fail();
  const p = new URLSearchParams(raw);
  const hash = p.get('hash') ?? '';
  if (!/^[0-9a-f]{64}$/.test(hash)) fail();
  const check = hmac(hmac('WebAppData', token), checkString(p));
  if (!crypto.timingSafeEqual(check, Buffer.from(hash, 'hex'))) fail();
  const authDate = Number(p.get('auth_date'));
  const age = now().getTime() / 1000 - authDate;
  if (!Number.isInteger(authDate) || age > MAX_AGE_S || age < -300) fail();
  let user;
  try { user = JSON.parse(p.get('user') ?? ''); } catch { fail(); }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 || user.is_bot) fail();
  return { user, authDate, hash };
}

// The 5-minute cache by `hash` of one instance (10 §7.2); the age is checked again on every hit.
export function initDataChecker(env = process.env, { now = clockNow } = {}) {
  const cache = new Map();
  return raw => {
    const hash = typeof raw === 'string' ? new URLSearchParams(raw).get('hash') : null;
    const hit = hash && cache.get(hash);
    const at = now().getTime();
    if (hit && hit.raw === raw && at - hit.at < CACHE_MS && at / 1000 - hit.v.authDate <= MAX_AGE_S) return hit.v;
    const v = verifyInitData(raw, env.TELEGRAM_BOT_TOKEN, { now });
    if (cache.size > 1000) cache.clear();
    cache.set(v.hash, { raw, at, v });
    return v;
  };
}
