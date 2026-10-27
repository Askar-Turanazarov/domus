// Manager sign-in by password. Only a hash is stored: ADMIN_PASSWORD_HASH = "scrypt:<salt hex>:<hash hex>"
// (npm run admin-password). A good password gives a signed session cookie; the cookie is keyed by the hash itself,
// so a new password ends every open session. No server-side session table: works the same on Vercel.
import crypto from 'node:crypto';

const COOKIE = 'fsp_adm';
const TTL_MS = 12 * 3600e3;
const KEYLEN = 32;

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

const sign = (stored, exp) => crypto.createHmac('sha256', 'fsp-admin-session|' + stored).update(String(exp)).digest('hex');

// The cookie value for a new session: "<expiry ms>.<hmac>".
const newSession = (stored, now = Date.now()) => { const exp = now + TTL_MS; return `${exp}.${sign(stored, exp)}`; };

function validSession(value, stored, now = Date.now()) {
  const m = /^(\d{13})\.([0-9a-f]{64})$/.exec(String(value || ''));
  if (!m || !parseHash(stored) || Number(m[1]) <= now) return false;
  const got = Buffer.from(m[2], 'hex'), want = Buffer.from(sign(stored, m[1]), 'hex');
  return crypto.timingSafeEqual(got, want);
}

// One cookie from the Cookie header. Pure.
function readCookie(header, name = COOKIE) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

// Set-Cookie for the session (value '' clears it). Secure over https (Vercel), plain on http://localhost.
function cookieHeader(value, secure) {
  return [`${COOKIE}=${value}`, 'Path=/api', 'HttpOnly', 'SameSite=Strict', value ? `Max-Age=${TTL_MS / 1000}` : 'Max-Age=0', secure && 'Secure']
    .filter(Boolean).join('; ');
}

export { COOKIE, TTL_MS, hashPassword, parseHash, verifyPassword, newSession, validSession, readCookie, cookieHeader };
