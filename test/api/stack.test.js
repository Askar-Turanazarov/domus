// /stack: its own sign-in (STACK_LOGIN + STACK_PASSWORD_HASH). Without the cookie — the form and 404 on the tour files;
// a wrong password → 401, the right one → the cookie and the tour; no CSRF header → 403; no STACK_* → 503; logout clears.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import path from 'node:path';
import { mountStack, stackConfig, newVisit, validVisit } from '../../server/http/stack.js';
import { hashPassword } from '../../server/adminAuth.js';
import { createTestDb, resetDb } from '../support/db.js';

const PAGES = path.join(import.meta.dirname, '..', '..', 'pages');
const LOGIN = 'tour', PASSWORD = 'tour-test-password-1';
let db, servers = [], base, closed;

function serve(env) {
  const app = express();
  mountStack(app, db, { env, pagesDir: PAGES });
  const s = app.listen(0);
  servers.push(s);
  return `http://127.0.0.1:${s.address().port}`;
}

before(async () => {
  db = await createTestDb();
  base = serve({ STACK_LOGIN: LOGIN, STACK_PASSWORD_HASH: await hashPassword(PASSWORD) });
  closed = serve({});
});
after(async () => { servers.forEach(s => s.close()); await db.close(); });
beforeEach(() => resetDb(db));

const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'domus-stack' };
const login = (url, body, headers = H) => fetch(`${url}/api/stack/login`, { method: 'POST', headers, body: JSON.stringify(body) });
const page = (url, p, cookie) => fetch(url + p, { headers: cookie ? { cookie } : {}, redirect: 'manual' });

test('no cookie: /stack → /stack/, the sign-in form, the tour files 404, private headers', async () => {
  assert.equal((await page(base, '/stack')).headers.get('location'), '/stack/');
  const r = await page(base, '/stack/');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.match(r.headers.get('x-robots-tag'), /noindex/);
  const html = await r.text();
  assert.match(html, /id="skLogin"/);
  assert.doesNotMatch(html, /stack\.js/);
  for (const f of ['stack.js', 'stack.css', 'i18n.js', '..%2Fdashboard.html']) assert.equal((await page(base, `/stack/${f}`)).status, 404, f);
});

test('wrong password or login → 401, no cookie', async () => {
  for (const body of [{ login: LOGIN, password: 'nope-nope-nope' }, { login: 'other', password: PASSWORD }]) {
    const r = await login(base, body);
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('set-cookie'), null);
  }
});

test('right password → cookie; the tour and its files open; logout clears the cookie', async () => {
  const r = await login(base, { login: 'TOUR', password: PASSWORD });
  assert.equal(r.status, 200);
  const set = r.headers.get('set-cookie');
  assert.match(set, /^dsk=\d{13}\.[\w-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200/);
  const cookie = set.split(';')[0];
  assert.match(await (await page(base, '/stack/', cookie)).text(), /\/stack\/stack\.js/);
  const js = await page(base, '/stack/stack.js', cookie);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.equal((await page(base, '/stack/missing.js', cookie)).status, 404);

  const out = await fetch(`${base}/api/stack/logout`, { method: 'POST', headers: { 'X-Requested-With': 'domus-stack' } });
  assert.equal(out.status, 204);
  assert.match(out.headers.get('set-cookie'), /^dsk=; .*Max-Age=0/);
});

test('no CSRF header or a foreign origin → 403', async () => {
  assert.equal((await login(base, { login: LOGIN, password: PASSWORD }, { 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await login(base, { login: LOGIN, password: PASSWORD }, { ...H, Origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(`${base}/api/stack/logout`, { method: 'POST' })).status, 403);
});

test('no STACK_* → 503, and the form is still served', async () => {
  assert.equal((await login(closed, { login: LOGIN, password: PASSWORD })).status, 503);
  assert.match(await (await page(closed, '/stack/')).text(), /id="skLogin"/);
});

test('the 11th try in 15 minutes → 429', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await login(base, { login: LOGIN, password: 'nope-nope-nope' })).status, 401);
  assert.equal((await login(base, { login: LOGIN, password: PASSWORD })).status, 429);
});

test('the visit: forged, expired and old-password cookies do not hold', async () => {
  const cfg = stackConfig({ STACK_LOGIN: LOGIN, STACK_PASSWORD_HASH: await hashPassword(PASSWORD) });
  const at = Date.parse('2026-10-28T10:00:00Z');
  const v = newVisit(cfg, at);
  assert.equal(validVisit(cfg, v, at), true);
  assert.equal(validVisit(cfg, v, at + 12 * 3600e3), false);
  assert.equal(validVisit(cfg, `${v.slice(0, -1)}${v.endsWith('A') ? 'B' : 'A'}`, at), false);
  const other = stackConfig({ STACK_LOGIN: LOGIN, STACK_PASSWORD_HASH: await hashPassword(PASSWORD) });
  assert.equal(validVisit(other, v, at), false);
  assert.equal(stackConfig({ STACK_LOGIN: LOGIN, STACK_PASSWORD_HASH: 'plain' }), null);
});
