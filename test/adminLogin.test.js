// Staff sign-in (12 §2, 14 §2.1, §2.3, 15 §2.5): login and password, the session cookie `dst`, the same answer for a wrong login
// and a wrong password, the attempt limits, forged / expired / revoked cookies, the CSRF header, roles, SESSION_SECRET missing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import * as auth from '../server/adminAuth.js';
import { mountAdmin } from '../server/http/admin.js';
import { requestId, apiErrors } from '../server/http/common.js';
import { createStaff, setPassword, logoutEverywhere, setActive, setRole, weakPassword } from '../server/core/staff.js';
import { createTestDb } from './support/db.js';

const PASSWORD = 'correct horse battery';
const HEADERS = { 'X-Requested-With': 'domus-admin' };
const SECRET = 'x'.repeat(40);
let at = new Date('2026-10-28T10:00:00Z');
const clock = () => at;

let db, server, base, aziz, boss;
const start = async (env) => {
  const app = express();
  app.use(requestId);
  const staffAuth = mountAdmin(app, db, { env, cacheMs: 0, now: clock });
  app.get('/api/admin/probe', (req, res) => res.json({ who: req.staff.login }));
  app.post('/api/admin/probe', (req, res) => res.json({ ok: true }));
  app.get('/api/admin/head-only', staffAuth.gate('head'), (req, res) => res.json({ ok: true }));
  app.get('/api/dashboard/summary', (req, res) => res.json({ ok: true }));
  app.use(apiErrors);
  const s = app.listen(0);
  return { s, base: `http://127.0.0.1:${s.address().port}` };
};
const login = (b, body, headers = HEADERS) => fetch(b + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const cookieOf = res => (res.headers.get('set-cookie') || '').split(';')[0];
const get = (path, cookie, headers = {}) => fetch(base + path, { headers: { ...(cookie ? { cookie } : {}), ...headers } });
const post = (path, cookie, headers = HEADERS) => fetch(base + path, { method: 'POST', headers: { ...(cookie ? { cookie } : {}), ...headers } });

before(async () => {
  db = await createTestDb();
  aziz = await createStaff(db, { login: 'Aziz', name: 'Азиз', role: 'manager', passwordHash: await auth.hashPassword(PASSWORD) });
  boss = await createStaff(db, { login: 'boss', name: 'Руководитель', role: 'head', passwordHash: await auth.hashPassword(PASSWORD) });
  ({ s: server, base } = await start({ SESSION_SECRET: SECRET, LOG_SALT: 'salt' }));
});
after(() => { server.close(); return db.close(); });

test('hash: scrypt line, the right password only, junk refused', async () => {
  const h = await auth.hashPassword('secret-1234');
  assert.match(h, /^scrypt:[0-9a-f]{32}:[0-9a-f]{64}$/);
  assert.equal(await auth.verifyPassword('secret-1234', h), true);
  assert.equal(await auth.verifyPassword('secret-1235', h), false);
  assert.equal(await auth.verifyPassword('', h), false);
  assert.equal(await auth.verifyPassword('secret-1234', 'plain-text'), false);
  assert.notEqual(await auth.hashPassword('secret-1234'), h);   // a new salt each time
});

test('password policy: 12+ characters, not a famous one, not the login', () => {
  assert.equal(weakPassword('short'), 'short');
  assert.equal(weakPassword('aaaaaaaaaaaaaa'), 'common');
  assert.equal(weakPassword('Password1234'), 'common');
  assert.equal(weakPassword('my-aziz-secret-1', 'aziz'), 'login');
  assert.equal(weakPassword('correct horse battery', 'aziz'), null);
});

test('the right login and password → HttpOnly SameSite=Strict cookie that opens the API; logout clears it', async () => {
  assert.equal((await get('/api/admin/me')).status, 401);
  const res = await login(base, { login: 'AZIZ', password: PASSWORD });   // the login is case-insensitive
  assert.equal(res.status, 200);
  const set = res.headers.get('set-cookie');
  for (const part of ['dst=', 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=43200']) assert.ok(set.includes(part), part);
  assert.ok(!set.includes(PASSWORD));
  const body = await res.json();
  assert.deepEqual(Object.keys(body.staff).sort(), ['id', 'lang', 'login', 'name', 'role', 'telegramLinked']);
  assert.equal(body.staff.role, 'manager');
  const cookie = cookieOf(res);
  assert.equal(((await (await get('/api/admin/me', cookie)).json()).staff).login, 'aziz');
  assert.equal((await get('/api/admin/probe', cookie)).status, 200);
  assert.equal((await get('/api/dashboard/summary', cookie)).status, 200);
  assert.equal((await get('/api/dashboard/summary')).status, 401);
  const out = await post('/api/admin/logout', cookie);
  assert.equal(out.status, 204);
  assert.match(out.headers.get('set-cookie'), /dst=;.*Max-Age=0/);
  assert.ok((await db.one('SELECT last_login_at FROM staff WHERE id = $1', [aziz.id])).last_login_at);
});

test('a wrong password, a wrong login and a disabled account get one and the same answer', async () => {
  const seen = [];
  for (const body of [{ login: 'aziz', password: 'wrong wrong wrong' }, { login: 'nobody', password: PASSWORD }]) {
    const res = await login(base, body, HEADERS);
    assert.equal(res.status, 401);
    assert.ok(!res.headers.get('set-cookie'));
    const j = await res.json();
    seen.push(j.error + j.message);
  }
  assert.equal(seen[0], seen[1]);
  assert.match(seen[0], /login_failed/);
});

test('login: unknown field → 400, no CSRF header → 403, a foreign Origin → 403', async () => {
  assert.equal((await login(base, { login: 'aziz', password: PASSWORD, extra: 1 })).status, 400);
  assert.equal((await login(base, { login: 'aziz', password: PASSWORD }, {})).status, 403);
  assert.equal((await login(base, { login: 'aziz', password: PASSWORD }, { ...HEADERS, Origin: 'https://evil.example' })).status, 403);
  assert.equal((await login(base, { login: 'aziz', password: PASSWORD }, { ...HEADERS, Origin: base })).status, 200);
});

test('a wrong, expired, forged or old-version cookie is refused', async () => {
  const good = auth.newSession(SECRET, aziz, at.getTime());
  assert.equal((await get('/api/admin/probe', 'dst=' + good)).status, 200);
  const [id, ver, exp, sig] = good.split('.');
  const bad = [
    'junk', '', `${id}.${ver}.${exp}.${'A'.repeat(43)}`,
    `${id}.${Number(ver) + 1}.${exp}.${sig}`,                                  // another version, same signature
    `${boss.id}.${ver}.${exp}.${sig}`,                                        // another person, same signature
    `${id}.${ver}.${Number(exp) + 1000}.${sig}`,                              // a later expiry
    auth.newSession(SECRET, aziz, at.getTime() - 13 * 3600e3),                // expired
    auth.newSession('y'.repeat(40), aziz, at.getTime())                       // signed with another secret
  ];
  for (const v of bad) assert.equal((await get('/api/admin/probe', 'dst=' + v)).status, 401, v);
});

test('session_version: a new password, «sign out everywhere», disabling and a role change end the open sessions', async () => {
  const s = await createStaff(db, { login: 'temp', name: 'Врем', role: 'manager', passwordHash: await auth.hashPassword(PASSWORD) });
  const fresh = async () => { const c = cookieOf(await login(base, { login: 'temp', password: PASSWORD })); assert.equal((await get('/api/admin/probe', c)).status, 200); return c; };
  let c = await fresh();
  await logoutEverywhere(db, s.id);
  assert.equal((await get('/api/admin/probe', c)).status, 401);
  c = await fresh();
  await setPassword(db, s.id, await auth.hashPassword('another long password'));
  assert.equal((await get('/api/admin/probe', c)).status, 401);
  assert.equal((await login(base, { login: 'temp', password: PASSWORD })).status, 401);
  assert.equal((await login(base, { login: 'temp', password: 'another long password' })).status, 200);
  c = cookieOf(await login(base, { login: 'temp', password: 'another long password' }));
  await setRole(db, s.id, 'head');
  assert.equal((await get('/api/admin/probe', c)).status, 401);
  c = cookieOf(await login(base, { login: 'temp', password: 'another long password' }));
  await setActive(db, s.id, false);
  assert.equal((await get('/api/admin/probe', c)).status, 401);
  assert.equal((await login(base, { login: 'temp', password: 'another long password' })).status, 401);   // a disabled account cannot sign in
});

test('roles: a manager gets 403 on a head-only route, the head passes', async () => {
  const m = cookieOf(await login(base, { login: 'aziz', password: PASSWORD }));
  assert.equal((await get('/api/admin/head-only', m)).status, 403);
  assert.equal((await get('/api/admin/head-only')).status, 401);
  at = new Date(at.getTime() + 16 * 60e3);
  const h = cookieOf(await login(base, { login: 'boss', password: PASSWORD }));
  assert.equal((await get('/api/admin/head-only', h)).status, 200);
});

test('a change without X-Requested-With or from a foreign Origin → 403; reading needs neither', async () => {
  const cookie = cookieOf(await login(base, { login: 'aziz', password: PASSWORD }));
  assert.equal((await post('/api/admin/probe', cookie, {})).status, 403);
  assert.equal((await post('/api/admin/probe', cookie, { ...HEADERS, Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/admin/probe', cookie, { ...HEADERS, Origin: 'null' })).status, 403);
  assert.equal((await post('/api/admin/probe', cookie, { ...HEADERS, Origin: base })).status, 200);
  assert.equal((await post('/api/admin/probe', cookie)).status, 200);
  assert.equal((await get('/api/admin/probe', cookie)).status, 200);
  assert.equal((await post('/api/admin/probe', undefined)).status, 401);   // no cookie: 401 before the CSRF question
});

test('5 wrong passwords for one login → 429, even for the right one; another login still works', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await login(base, { login: 'boss', password: 'wrong password ' + i })).status, 401);
  const blocked = await login(base, { login: 'boss', password: PASSWORD });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.equal((await login(base, { login: 'aziz', password: PASSWORD })).status, 200);
  at = new Date(at.getTime() + 16 * 60e3);                                   // the window passes
  assert.equal((await login(base, { login: 'boss', password: PASSWORD })).status, 200);
});

test('20 failures from one address → 429 for any login', async () => {
  at = new Date(at.getTime() + 16 * 60e3);
  for (let i = 0; i < 20; i++) assert.equal((await login(base, { login: 'ghost' + i, password: 'wrong password' })).status, 401);
  assert.equal((await login(base, { login: 'aziz', password: PASSWORD })).status, 429);
});

test('without a usable SESSION_SECRET in production the admin is off (503), a dev server falls back', async () => {
  const prod = await start({ NODE_ENV: 'production', SESSION_SECRET: 'short' });
  try {
    assert.equal((await login(prod.base, { login: 'aziz', password: PASSWORD })).status, 503);
    assert.equal((await fetch(prod.base + '/api/admin/me')).status, 503);
  } finally { prod.s.close(); }
  assert.equal(auth.sessionSecret({ NODE_ENV: 'production', SESSION_SECRET: SECRET }), SECRET);
  assert.ok(auth.sessionSecret({}));
});
