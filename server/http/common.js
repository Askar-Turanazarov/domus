// What every HTTP entry shares (13 §1–2, 14 §5): the error table and answer, the language, rate limits, the Idempotency-Key
// header, the cookie `dcl` of a site client, strict bodies. The behaviour behind an entry stays in the core.
import crypto from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { DomainError } from '../core/errors.js';
import { now as clockNow } from '../core/clock.js';
import { t } from '../i18n/index.js';

// 13 §2: code → HTTP status. A code the core throws that is not here answers 400.
export const STATUS = {
  invalid_input: 400, idempotency_key_required: 400, unauthorized: 401, login_failed: 401, tg_auth_failed: 401, forbidden: 403,
  not_found: 404, link_invalid: 404, stale: 409, idempotency_conflict: 409, idempotency_in_progress: 409, payload_too_large: 413,
  rate_limited: 429, feature_disabled: 503, internal: 500,
  apartment_not_found: 404, apartment_sold: 409, apartment_not_free: 409, apartment_held: 409, already_booked_by_you: 409,
  booking_limit: 409, booking_not_found: 404, booking_closed: 409, booking_not_active: 409, consent_required: 422,
  phone_invalid: 422, name_invalid: 422, reason_required: 422, extend_too_long: 422, refund_not_allowed: 409, datetime_invalid: 422,
  datetime_past: 422, datetime_too_far: 422, outside_hours: 422, slot_taken: 409, down_payment_too_low: 422, term_not_available: 422,
  order_not_found: 404, stage_invalid: 409, prepay_required: 409, telegram_linked_elsewhere: 409,
  payment_not_found: 404, payment_closed: 409, booking_already_paid: 409, hold_expiring: 409, provider_unavailable: 409,
  provider_error: 502, card_invalid: 422, card_expired: 422, card_not_supported: 422, wrong_code: 422, order_already_paid: 409,
  order_closed: 409, refund_in_progress: 409, pdf_unavailable: 404,
  turn_in_progress: 409, chat_limit: 429, conversation_not_found: 404, pending_not_found: 404, confirm_expired: 410,
  confirm_used: 409, confirm_mismatch: 403, need_phone: 422, ai_unavailable: 503
};

const LANGS = ['ru', 'uz', 'en'];

// 13 §1.1: the body's `lang` → ?lang= → Accept-Language (the first of ru|uz|en) → ru.
export function langOf(req) {
  const asked = [req.body?.lang, req.query?.lang].find(l => LANGS.includes(l));
  if (asked) return asked;
  const header = String(req.get?.('accept-language') ?? '').split(',').map(s => s.trim().slice(0, 2).toLowerCase());
  return header.find(l => LANGS.includes(l)) ?? 'ru';
}

// X-Request-Id on every answer (01 §11): the platform's id when there is one.
export function requestId(req, res, next) {
  res.set('X-Request-Id', String(req.get('x-vercel-id') ?? crypto.randomBytes(6).toString('hex')).slice(0, 64));
  next();
}

// No-store on /api/* unless the route chose its own (13 §1.8).
export function noStore(req, res, next) {
  if (!res.get('Cache-Control')) res.set('Cache-Control', 'no-store');
  next();
}

// 13 §1.2: DomainError → { error, message, vars, fields?, requestId } with its status; anything else → 500 without details.
// `prefer` — a key prefix whose text wins over `err.` (the card emulator words «card_not_supported» for the training cards).
export function sendError(res, e, lang = 'ru', prefer = null) {
  const requestId = res.get('X-Request-Id');
  if (!(e instanceof DomainError)) {
    console.error('api:', e?.message);
    return res.status(500).json({ error: 'internal', message: t(lang, 'err.internal'), requestId });
  }
  const { fields, ...vars } = e.vars ?? {};
  const subst = { ...vars, fields: fields?.join(', ') ?? '' };
  const message = (prefer && t(lang, `${prefer}.${e.code}`, subst)) || t(lang, `err.${e.code}`, subst) || e.code;
  if (e.code === 'rate_limited') res.set('Retry-After', String(vars.retryAfter ?? 1));
  return res.status(STATUS[e.code] ?? 400).json({ error: e.code, message, vars, ...(fields ? { fields } : {}), requestId });
}

// Error middleware (last): a broken or too big JSON body is our error format too, not Express's HTML page.
export function apiErrors(err, req, res, next) {
  if (res.headersSent) return next(err);
  const lang = langOf(req);
  if (err?.type === 'entity.too.large') return sendError(res, new DomainError('payload_too_large'), lang);
  if (err?.type === 'entity.parse.failed' || err?.type === 'charset.unsupported' || err?.type === 'encoding.unsupported') {
    return sendError(res, new DomainError('invalid_input'), lang);
  }
  return sendError(res, err, lang);
}

// Own JSON parser of a small route (13 §1.1: 64 KB); the Domus order keeps its 4 MB parser.
export const jsonBody = express.json({ limit: '64kb' });

// 14 §2.3, §15: a change whose Origin is another site ("null" and junk count as foreign); no Origin — not a browser form.
export function foreignOrigin(req) {
  const origin = req.get('origin');
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !origin) return false;
  try { return new URL(origin).host !== req.get('host'); } catch { return true; }
}

// The `run` wrapper: security headers of personal pages, one place for errors.
export const handler = fn => async (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  try {
    await fn(req, res);
  } catch (e) {
    sendError(res, e, langOf(req));
  }
};

// ---- rate limits (14 §5): a fixed window in rate_limits, checked BEFORE the transaction ----

export const ipKey = (req, env = process.env) =>
  crypto.createHash('sha256').update(`${req.ip ?? ''}${env.LOG_SALT ?? ''}`).digest('hex').slice(0, 16);
export const hashKey = (s, env = process.env) =>
  crypto.createHash('sha256').update(`${s}${env.LOG_SALT ?? ''}`).digest('hex').slice(0, 16);

// limit hits per windowMs for the key; the one over it → err:rate_limited with the seconds left.
export async function limit(db, key, max, windowMs, { now = clockNow } = {}) {
  const at = now().getTime();
  const start = new Date(Math.floor(at / windowMs) * windowMs);
  const r = await db.one(`INSERT INTO rate_limits (key, window_start, count) VALUES ($1, $2, 1)
    ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1 RETURNING count`, [key, start]);
  if (r.count > max) throw new DomainError('rate_limited', { retryAfter: Math.max(1, Math.ceil((start.getTime() + windowMs - at) / 1000)) });
}
export const HOUR = 3600e3, MINUTE = 60e3;

// ---- Idempotency-Key (13 §1.3) ----

// The key of a state-changing POST; the core stores and replays the answer (scopes 'hold', 'payment').
export function idempotencyKey(req) {
  const k = String(req.get('idempotency-key') ?? '').trim();
  if (!/^[\w-]{8,64}$/.test(k)) throw new DomainError('idempotency_key_required');
  return k;
}

// ---- strict bodies (13 §1.1): unknown fields are an error; empty strings are absent ----

const strip = v => {
  if (typeof v === 'string') return v.trim() === '' ? undefined : v.trim();
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, strip(x)]).filter(([, x]) => x !== undefined));
  }
  return v;
};

// shape — { field: zod type }; → the parsed body or err:invalid_input with `fields`.
export function parseBody(shape, body) {
  const r = z.strictObject(shape).safeParse(strip(body ?? {}));
  if (r.success) return r.data;
  const fields = [...new Set(r.error.issues.flatMap(i => i.code === 'unrecognized_keys' ? i.keys : [String(i.path[0] ?? 'body')]))];
  throw new DomainError('invalid_input', { fields });
}
export { z };

// ---- the cookie `dcl` of a site client (03 §9.4): <clientId>.<HMAC(SESSION_SECRET, clientId)> ----

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isProd = env => env.NODE_ENV === 'production' || env.VERCEL_ENV === 'production';
const mac = (id, env) => {
  const secret = env.SESSION_SECRET || (isProd(env) ? null : 'dev-session-secret');
  if (!secret) throw new Error('SESSION_SECRET is not set');
  return crypto.createHmac('sha256', secret).update(id).digest('base64url');
};

export function readDcl(req, env = process.env) {
  const m = /(?:^|;\s*)dcl=([^;]+)/.exec(req.get('cookie') ?? '');
  if (!m) return null;
  const [id, sig] = decodeURIComponent(m[1]).split('.');
  if (!UUID.test(id ?? '') || !sig) return null;
  const want = Buffer.from(mac(id, env)), got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? id : null;
}

export function setDcl(res, req, clientId, env = process.env) {
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  res.append('Set-Cookie', `dcl=${encodeURIComponent(`${clientId}.${mac(clientId, env)}`)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${180 * 86400}${secure ? '; Secure' : ''}`);
}

// ---- the cookie `dvid` of a site visitor (11 §11.1): 16 random bytes, base64url, only for the funnel; 365 days ----
export function readDvid(req) {
  const m = /(?:^|;\s*)dvid=([A-Za-z0-9_-]{22})(?:;|$)/.exec(req.get('cookie') ?? '');
  return m ? m[1] : null;
}

export function setDvid(res, req, id) {
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  res.append('Set-Cookie', `dvid=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${365 * 86400}${secure ? '; Secure' : ''}`);
}

// Tashkent time for answers (13 §1.1): 2026-10-27T18:15:00+05:00.
export const tz = d => (d == null ? null : new Date(new Date(d).getTime() + 5 * 3600e3).toISOString().slice(0, 19) + '+05:00');

// Idempotency-Key of a staff change (13 §1.3): the same key with the same request returns the stored answer, with another
// request — 409. Only a finished answer is stored: after an error the repeat runs again and meets the same error.
export async function once(db, ctx, scope, key, payload, run) {
  const hash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const k = await db.one('SELECT * FROM idempotency_keys WHERE scope = $1 AND key = $2', [scope, key]);
  if (k) {
    if (k.request_hash !== hash) throw new DomainError('idempotency_conflict');
    if (k.response) return { status: k.status, body: k.response };
  }
  const out = await run();
  await db.query(`INSERT INTO idempotency_keys (scope, key, request_hash, status, response, created_at) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT DO NOTHING`, [scope, key, hash, out.status, JSON.stringify(out.body), ctx.now()]);
  return out;
}
