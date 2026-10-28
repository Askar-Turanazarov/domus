// Staff entrances (12 §2, 13 §9.1, 14 §2.1, §2.3): login, logout, me, and the gate in front of /api/admin/* and /api/dashboard/*.
// The gate answers 401 without a session, 403 for a wrong role or a change without X-Requested-With; the role is checked
// here (the entrance) and again in the core (actor.role). Every admin route is mounted behind it, so a new one is closed by default.
import { DomainError } from '../core/errors.js';
import { now as clockNow } from '../core/clock.js';
import { staffById, staffByLogin, touchLogin } from '../core/staff.js';
import * as auth from '../adminAuth.js';
import { handler, jsonBody, parseBody, z, ipKey, hashKey, tz, sendError, langOf, foreignOrigin } from './common.js';

export const CSRF_HEADER = 'domus-admin';
const FAILS_PER_LOGIN = 5, FAILS_PER_IP = 20, WINDOW = 15 * 60e3;
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

// The staff member as the screens see them (no hash, no codes).
export const publicStaff = s => ({ id: s.id, login: s.login, name: s.name, role: s.role, lang: s.lang, telegramLinked: s.telegram_user_id != null });

// An Origin from another site on a change is refused (SameSite=Strict already stops it; this is a second lock).
// opts — { env, cacheMs (staff row cache, 30 s by default; 0 in tests), now }.
export function createStaffAuth(db, opts = {}) {
  const env = opts.env ?? process.env;
  const now = opts.now ?? clockNow;
  const cacheMs = opts.cacheMs ?? 30_000;
  const cache = new Map();                                   // id → { row, at }; one function instance's memory

  async function load(id) {
    const hit = cache.get(id);
    if (hit && now().getTime() - hit.at < cacheMs) return hit.row;
    const row = await staffById(db, id);
    if (cache.size > 200) cache.clear();
    cache.set(id, { row, at: now().getTime() });
    return row;
  }

  // The session cookie → the active staff row whose session_version still matches | null.
  async function sessionOf(req) {
    const secret = auth.sessionSecret(env);
    const s = auth.readSession(secret, auth.readCookie(req.get('cookie')), now().getTime());
    if (!s) return null;
    const row = await load(s.id);
    return row?.active && row.session_version === s.version ? row : null;
  }

  // roles — none: any staff member; ['head']: the head only.
  const gate = (...roles) => async (req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    try {
      if (!auth.sessionSecret(env)) throw new DomainError('feature_disabled');
      const staff = await sessionOf(req);
      if (!staff) throw new DomainError('unauthorized');
      if (roles.length && !roles.includes(staff.role)) throw new DomainError('forbidden');
      if (!SAFE.has(req.method) && (req.get('x-requested-with') !== CSRF_HEADER || foreignOrigin(req))) throw new DomainError('forbidden');
      req.staff = staff;
      req.actor = { type: 'staff', id: staff.id, role: staff.role, channel: 'admin' };
    } catch (e) {
      return sendError(res, e, langOf(req));
    }
    next();
  };

  const forget = id => cache.delete(id);
  return { sessionOf, gate, forget };
}

// Failed sign-ins in the current 15-minute window of the key.
async function failures(db, key, at) {
  const start = new Date(Math.floor(at / WINDOW) * WINDOW);
  const r = await db.one('SELECT count FROM rate_limits WHERE key = $1 AND window_start = $2', [key, start]);
  return { count: r?.count ?? 0, retryAfter: Math.max(1, Math.ceil((start.getTime() + WINDOW - at) / 1000)) };
}
async function addFailure(db, key, at) {
  const start = new Date(Math.floor(at / WINDOW) * WINDOW);
  await db.query(`INSERT INTO rate_limits (key, window_start, count) VALUES ($1, $2, 1)
    ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1`, [key, start]);
}

// Mounts login / logout / me and closes everything else under /api/admin and /api/dashboard behind the gate.
// → the auth object, for routes mounted later (head-only gates) and for tests.
export function mountAdmin(app, db, opts = {}) {
  const env = opts.env ?? process.env;
  const now = opts.now ?? clockNow;
  const staffAuth = createStaffAuth(db, opts);
  app.use('/api/admin', jsonBody);

  app.post('/api/admin/login', handler(async (req, res) => {
    const secret = auth.sessionSecret(env);
    if (!secret) throw new DomainError('feature_disabled');
    if (req.get('x-requested-with') !== CSRF_HEADER || foreignOrigin(req)) throw new DomainError('forbidden');
    const body = parseBody({ login: z.string().max(100), password: z.string().max(200) }, req.body);
    const at = now().getTime();
    const loginKey = `login:login:${hashKey(body.login.toLowerCase(), env)}`, ipk = `login:ip:${ipKey(req, env)}`;
    const [byLogin, byIp] = [await failures(db, loginKey, at), await failures(db, ipk, at)];
    if (byLogin.count >= FAILS_PER_LOGIN || byIp.count >= FAILS_PER_IP) {
      throw new DomainError('rate_limited', { retryAfter: Math.max(byLogin.count >= FAILS_PER_LOGIN ? byLogin.retryAfter : 0, byIp.count >= FAILS_PER_IP ? byIp.retryAfter : 0) });
    }
    const staff = await staffByLogin(db, body.login);
    // scrypt is spent whether or not the login exists
    const ok = staff?.active ? await auth.verifyPassword(body.password, staff.password_hash) : (await auth.burn(body.password), false);
    if (!ok) {
      await Promise.all([addFailure(db, loginKey, at), addFailure(db, ipk, at)]);
      console.warn('staff.login_failed', JSON.stringify({ login: body.login.slice(0, 40), ip: ipKey(req, env) }));
      throw new DomainError('login_failed');
    }
    await touchLogin(db, staff.id, { now });
    staffAuth.forget(staff.id);
    console.log('staff.login', staff.login);
    res.set('Set-Cookie', auth.cookieHeader(auth.newSession(secret, staff, at), req.secure)).json({ staff: publicStaff(staff) });
  }));

  app.post('/api/admin/logout', handler(async (req, res) => {
    if (req.get('x-requested-with') !== CSRF_HEADER) throw new DomainError('forbidden');
    res.set('Set-Cookie', auth.cookieHeader('', req.secure)).status(204).end();
  }));

  app.use('/api/admin', staffAuth.gate());                   // from here on: a signed-in staff member
  app.use('/api/dashboard', staffAuth.gate());

  app.get('/api/admin/me', handler(async (req, res) => {
    res.json({ staff: publicStaff(req.staff), at: tz(now()) });
  }));

  return staffAuth;
}
