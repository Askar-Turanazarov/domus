// Manager sign-in by password: session cookie, wrong password, the attempt limit, forged cookies, sign-out,
// the Bearer token for scripts, changes from another site.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as auth from '../server/adminAuth.js';

const PASSWORD = 'correct horse battery';
process.env.ADMIN_TOKEN = 'login-test-token-1234567';
process.env.ADMIN_PASSWORD_HASH = await auth.hashPassword(PASSWORD);
const { default: app } = await import('../server.js');
const server = app.listen(0);
after(() => server.close());
const base = () => `http://127.0.0.1:${server.address().port}`;
const login = (password, headers = {}) => fetch(base() + '/api/admin/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ password }) });
const cookieOf = res => (res.headers.get('set-cookie') || '').split(';')[0];
const orders = (headers = {}) => fetch(base() + '/api/orders', { headers });

test('hash: scrypt line, the right password only, junk refused', async () => {
  const h = await auth.hashPassword('secret-1234');
  assert.match(h, /^scrypt:[0-9a-f]{32}:[0-9a-f]{64}$/);
  assert.equal(await auth.verifyPassword('secret-1234', h), true);
  assert.equal(await auth.verifyPassword('secret-1235', h), false);
  assert.equal(await auth.verifyPassword('', h), false);
  assert.equal(await auth.verifyPassword('secret-1234', 'plain-text'), false);
  assert.notEqual(await auth.hashPassword('secret-1234'), h);   // a new salt each time
});

test('the right password → HttpOnly SameSite=Strict cookie that opens the API; sign-out closes it', async () => {
  assert.equal((await fetch(base() + '/api/admin/me')).status, 401);
  const res = await login(PASSWORD);
  assert.equal(res.status, 200);
  const set = res.headers.get('set-cookie');
  for (const part of ['HttpOnly', 'SameSite=Strict', 'Path=/api', 'Max-Age=43200']) assert.ok(set.includes(part), part);
  assert.ok(!set.includes(PASSWORD));
  const cookie = cookieOf(res);
  assert.equal((await fetch(base() + '/api/admin/me', { headers: { cookie } })).status, 200);
  assert.equal((await orders({ cookie })).status, 200);
  const out = await fetch(base() + '/api/admin/logout', { method: 'POST', headers: { cookie } });
  assert.match(out.headers.get('set-cookie'), /fsp_adm=;.*Max-Age=0/);
});

test('a wrong, expired or forged cookie is refused', async () => {
  assert.equal((await orders()).status, 401);
  const exp = Date.now() + 3600e3;
  for (const v of ['junk', `${exp}.${'0'.repeat(64)}`, auth.newSession('scrypt:' + '1'.repeat(32) + ':' + '2'.repeat(64)),
    auth.newSession(process.env.ADMIN_PASSWORD_HASH, Date.now() - 13 * 3600e3)]) {
    assert.equal((await orders({ cookie: 'fsp_adm=' + v })).status, 401, v);
  }
});

test('a change with the cookie from another site → 403; the same site passes', async () => {
  const cookie = cookieOf(await login(PASSWORD));
  const patch = origin => fetch(base() + '/api/orders/999', { method: 'PATCH',
    headers: { cookie, 'Content-Type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify({ status: 'done' }) });
  assert.equal((await patch('https://evil.example')).status, 403);
  assert.equal((await patch('null')).status, 403);
  assert.equal((await patch(base())).status, 404);   // passes the check, the order does not exist
  assert.equal((await login(PASSWORD, { origin: 'https://evil.example' })).status, 403);
});

test('the Bearer ADMIN_TOKEN still works for scripts', async () => {
  assert.equal((await orders({ Authorization: 'Bearer ' + process.env.ADMIN_TOKEN })).status, 200);
  assert.equal((await orders({ Authorization: 'Bearer wrong-token-wrong-token' })).status, 401);
});

test('5 wrong passwords → 429, even for the right one, until the window passes', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await login('wrong password ' + i)).status, 401);
  assert.equal((await login('wrong again')).status, 429);
  assert.equal((await login(PASSWORD)).status, 429);
});
