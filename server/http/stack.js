// /stack — the tour of the stack: a page behind its own sign-in (STACK_LOGIN + STACK_PASSWORD_HASH, not a staff account).
// Without a valid cookie /stack/ is a sign-in form and the tour files answer 404; the files live in pages/stack/, not in
// public/, so the CDN never serves them past the check. The cookie dsk = <exp ms>.<sig>,
// sig = HMAC-SHA256(SESSION_SECRET, "stack:<exp>:<tail of the hash>"): a new password ends the open visits.
// No STACK_* or SESSION_SECRET in the environment → the form says the page is closed (503).
import path from 'node:path';
import crypto from 'node:crypto';
import { DomainError } from '../core/errors.js';
import { now as clockNow } from '../core/clock.js';
import * as auth from '../adminAuth.js';
import { handler, jsonBody, parseBody, z, ipKey, limit, foreignOrigin, MINUTE } from './common.js';

export const STACK_COOKIE = 'dsk';
export const STACK_CSRF = 'domus-stack';
const TTL_MS = 12 * 3600e3;
const TRIES = 10;                                             // sign-in attempts per IP in 15 minutes
const FILE = /^[\w-]{1,40}\.(js|css)$/;
const PRIVATE = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' };

// { login, hash, secret } | null when the page is closed.
export function stackConfig(env = process.env) {
  const login = String(env.STACK_LOGIN || '').trim(), hash = String(env.STACK_PASSWORD_HASH || '').trim();
  const secret = auth.sessionSecret(env);
  return login && auth.parseHash(hash) && secret ? { login, hash, secret } : null;
}

const sign = (cfg, exp) => crypto.createHmac('sha256', cfg.secret).update(`stack:${exp}:${cfg.hash.slice(-16)}`).digest('base64url');
export const newVisit = (cfg, at) => { const exp = at + TTL_MS; return `${exp}.${sign(cfg, exp)}`; };

// The cookie value → true when the signature holds and it has not expired. Pure.
export function validVisit(cfg, value, at) {
  const m = /^(\d{13})\.([\w-]{43})$/.exec(String(value || ''));
  if (!cfg || !m || Number(m[1]) <= at) return false;
  const want = Buffer.from(sign(cfg, m[1])), got = Buffer.from(m[2]);
  return want.length === got.length && crypto.timingSafeEqual(got, want);
}

const cookie = (value, secure) => [`${STACK_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict',
  value ? `Max-Age=${TTL_MS / 1000}` : 'Max-Age=0', secure && 'Secure'].filter(Boolean).join('; ');

// opts — { env, now, pagesDir }.
export function mountStack(app, db, opts = {}) {
  const env = opts.env ?? process.env;
  const now = opts.now ?? clockNow;
  const dir = path.join(opts.pagesDir, 'stack');
  const signedIn = req => validVisit(stackConfig(env), auth.readCookie(req.get('cookie'), STACK_COOKIE), now().getTime());

  app.get('/stack', (req, res, next) => (req.originalUrl.split('?')[0] === '/stack' ? res.redirect(302, '/stack/') : next()));
  app.get('/stack/', (req, res) => res.set(PRIVATE).sendFile(path.join(dir, signedIn(req) ? 'index.html' : 'login.html')));
  app.get('/stack/:file', (req, res) => {
    const missing = () => res.set(PRIVATE).status(404).type('text').send('Not found');
    if (!FILE.test(req.params.file) || !signedIn(req)) return missing();
    res.set(PRIVATE).sendFile(path.join(dir, req.params.file), e => { if (e && !res.headersSent) missing(); });
  });

  app.use('/api/stack', jsonBody);
  app.post('/api/stack/login', handler(async (req, res) => {
    const cfg = stackConfig(env);
    if (!cfg) throw new DomainError('feature_disabled');
    if (req.get('x-requested-with') !== STACK_CSRF || foreignOrigin(req)) throw new DomainError('forbidden');
    const body = parseBody({ login: z.string().max(100), password: z.string().max(200) }, req.body);
    await limit(db, `stack:ip:${ipKey(req, env)}`, TRIES, 15 * MINUTE, { now });
    // scrypt is spent whether or not the login matches
    const ok = body.login.trim().toLowerCase() === cfg.login.toLowerCase()
      ? await auth.verifyPassword(body.password, cfg.hash) : (await auth.burn(body.password), false);
    if (!ok) {
      console.warn('stack.login_failed', JSON.stringify({ ip: ipKey(req, env) }));
      throw new DomainError('login_failed');
    }
    res.set('Set-Cookie', cookie(newVisit(cfg, now().getTime()), req.secure)).json({ ok: true });
  }));
  app.post('/api/stack/logout', handler(async (req, res) => {
    if (req.get('x-requested-with') !== STACK_CSRF) throw new DomainError('forbidden');
    res.set('Set-Cookie', cookie('', req.secure)).status(204).end();
  }));
}
