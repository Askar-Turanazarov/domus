// Personal links (03 §14): /b/<no>-<sig>, /o/<no>-<sig>. sig = base64url(HMAC-SHA256(LINK_SECRET, "<kind>:<id>:<access_version>")),
// first 32 chars. Not stored: computed again any time; a leak is cured by access_version + 1.
import crypto from 'node:crypto';

const DEV_SECRET = 'dev-link-secret';

function secretOf(env) {
  if (env.LINK_SECRET) return env.LINK_SECRET;
  if (env.NODE_ENV === 'production' || env.VERCEL_ENV === 'production') throw new Error('LINK_SECRET is not set');
  return DEV_SECRET;
}

export const sign = (kind, id, accessVersion, env = process.env) =>
  crypto.createHmac('sha256', secretOf(env)).update(`${kind}:${id}:${accessVersion}`).digest('base64url').slice(0, 32);

// The path for a booking row: '/b/1042-<sig>'.
export const bookingPath = (b, env = process.env) => `/b/${b.no}-${sign('booking', b.id, b.access_version, env)}`;

// '1042-<sig>' → { no, sig } | null. The caller loads the row by no and calls checkSig.
export function parseRef(ref) {
  const m = /^(\d{1,9})-([A-Za-z0-9_-]{32})$/.exec(String(ref ?? ''));
  return m ? { no: Number(m[1]), sig: m[2] } : null;
}

export function checkSig(kind, row, sig, env = process.env) {
  const want = Buffer.from(sign(kind, row.id, row.access_version, env));
  const got = Buffer.from(String(sig));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
