// Staff sign-in primitives (12 §2, 14 §2.1): scrypt password lines and the signed session cookie
//   dst = <staffId>.<sessionVersion>.<exp ms>.<sig>,  sig = base64url(HMAC-SHA256(SESSION_SECRET, "staff:<id>:<version>:<exp>")).
// No session table (as in Domus): works the same on Vercel; «sign out everywhere» is session_version + 1.
import crypto from 'node:crypto';

const COOKIE = 'dst';
const TTL_MS = 12 * 3600e3;
const KEYLEN = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// → "scrypt:<salt>:<hash>". Async: scrypt is slow on purpose.
function hashPassword(password, salt = crypto.randomBytes(16)) {
  return new Promise((ok, fail) => crypto.scrypt(String(password), salt, KEYLEN, (e, key) =>
    e ? fail(e) : ok(`scrypt:${salt.toString('hex')}:${key.toString('hex')}`)));
}

// "scrypt:<salt>:<hash>" → { salt, hash } | null. Pure.
function parseHash(stored) {
  const m = /^scrypt:([0-9a-f]{32}):([0-9a-f]{64})$/.exec(String(stored || '').trim());
  return m ? { salt: Buffer.from(m[1], 'hex'), hash: Buffer.from(m[2], 'hex') } : null;
}

async function verifyPassword(password, stored) {
  const p = parseHash(stored);
  if (!p || typeof password !== 'string' || !password || password.length > 200) return false;
  const key = await new Promise((ok, fail) => crypto.scrypt(password, p.salt, KEYLEN, (e, k) => (e ? fail(e) : ok(k))));
  return crypto.timingSafeEqual(key, p.hash);
}

// A line nobody has the password for: scrypt is spent on an unknown login too, so the time does not tell (14 §2.1).
const DUMMY = `scrypt:${'0'.repeat(32)}:${'0'.repeat(64)}`;
const burn = password => verifyPassword(String(password ?? '').slice(0, 200) || 'x', DUMMY);

const isProd = env => env.NODE_ENV === 'production' || env.VERCEL_ENV === 'production';

// SESSION_SECRET (≥ 32 characters, 14 §9). Locally and in tests a fixed dev value; in production none → null (the admin answers 503).
function sessionSecret(env = process.env) {
  const s = env.SESSION_SECRET;
  if (s && s.length >= 32) return s;
  if (isProd(env)) return null;
  return s || 'dev-session-secret-dev-session-secret';
}

const sign = (secret, id, version, exp) =>
  crypto.createHmac('sha256', secret).update(`staff:${id}:${version}:${exp}`).digest('base64url');

// The cookie value for a new session.
function newSession(secret, staff, now = Date.now()) {
  const exp = now + TTL_MS;
  return `${staff.id}.${staff.session_version}.${exp}.${sign(secret, staff.id, staff.session_version, exp)}`;
}

// The value → { id, version } when the signature holds and it has not expired, else null. The signature is compared
// in constant time on buffers of equal length (14 §4). Pure.
function readSession(secret, value, now = Date.now()) {
  const m = /^([0-9a-f-]{36})\.(\d{1,9})\.(\d{13})\.([\w-]{43})$/i.exec(String(value || ''));
  if (!secret || !m || !UUID.test(m[1])) return null;
  const want = Buffer.from(sign(secret, m[1], m[2], m[3])), got = Buffer.from(m[4]);
  if (want.length !== got.length || !crypto.timingSafeEqual(got, want) || Number(m[3]) <= now) return null;
  return { id: m[1], version: Number(m[2]) };
}

// One cookie from the Cookie header. Pure.
function readCookie(header, name = COOKIE) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ''; }
    }
  }
  return '';
}

// Set-Cookie for the session (value '' clears it). Secure over https (Vercel), plain on http://localhost.
function cookieHeader(value, secure) {
  return [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', value ? `Max-Age=${TTL_MS / 1000}` : 'Max-Age=0', secure && 'Secure']
    .filter(Boolean).join('; ');
}

export { COOKIE, TTL_MS, hashPassword, parseHash, verifyPassword, burn, sessionSecret, newSession, readSession, readCookie, cookieHeader };
