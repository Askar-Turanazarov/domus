// The session cookie signature with session_version (14 §2.1, 15 §2.5) and the script token ADMIN_TOKEN.
// ADMIN_TOKEN is read once at start: each token case runs the server in its own process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as auth from '../server/adminAuth.js';

const SECRET = 's'.repeat(40);
const staff = { id: crypto.randomUUID(), session_version: 3 };
const NOW = 1_800_000_000_000;

test('session: the value carries id, version and expiry; the right secret reads it back', () => {
  const v = auth.newSession(SECRET, staff, NOW);
  assert.match(v, /^[0-9a-f-]{36}\.3\.\d{13}\.[\w-]{43}$/);
  assert.deepEqual(auth.readSession(SECRET, v, NOW + 1000), { id: staff.id, version: 3 });
});

test('session: another secret, a changed field, an expired or malformed value → null', () => {
  const v = auth.newSession(SECRET, staff, NOW);
  const [id, ver, exp, sig] = v.split('.');
  assert.equal(auth.readSession('t'.repeat(40), v, NOW), null);
  assert.equal(auth.readSession(null, v, NOW), null);
  assert.equal(auth.readSession(SECRET, [id, 4, exp, sig].join('.'), NOW), null);
  assert.equal(auth.readSession(SECRET, [id, ver, Number(exp) + 1, sig].join('.'), NOW), null);
  assert.equal(auth.readSession(SECRET, [id, ver, exp, sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A')].join('.'), NOW), null);
  assert.equal(auth.readSession(SECRET, v, NOW + 13 * 3600e3), null);
  for (const junk of ['', 'a.b.c.d', undefined, null, '..', `${id}.${ver}.${exp}`]) assert.equal(auth.readSession(SECRET, junk, NOW), null);
});

test('cookie header: the value is read by name, a broken escape is not a crash', () => {
  assert.equal(auth.readCookie('a=1; dst=abc; b=2'), 'abc');
  assert.equal(auth.readCookie('a=1'), '');
  assert.equal(auth.readCookie('dst=%E0%A4%A'), '');
  assert.match(auth.cookieHeader('v', true), /^dst=v; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200; Secure$/);
  assert.match(auth.cookieHeader('', false), /Max-Age=0$/);
});

const server = new URL('../server.js', import.meta.url).href;
// Start the server with the given token, GET /api/orders with that token, print the status.
const statusWith = token => Number(execFileSync(process.execPath, ['--input-type=module', '-e', `
  const { default: app } = await import(${JSON.stringify(server)});
  const s = app.listen(0, async () => {
    const r = await fetch('http://127.0.0.1:' + s.address().port + '/api/orders', { headers: { Authorization: 'Bearer ' + process.env.ADMIN_TOKEN } });
    console.log(r.status); s.close();
  });`], { env: { ...process.env, ADMIN_TOKEN: token }, encoding: 'utf8' }).trim().split('\n').pop());

test('a short or placeholder ADMIN_TOKEN is not a way in (401: only a staff session remains)', () => {
  for (const weak of ['', '123', 'fifteen-chars-x', 'change-me-to-a-long-random-string', 'CHANGE-ME-please-1234567']) {
    assert.equal(statusWith(weak), 401, JSON.stringify(weak));
  }
});

test('a long random ADMIN_TOKEN works for scripts', () => {
  assert.equal(statusWith('0123456789abcdef'), 200);
  assert.equal(statusWith('9f2c4e6a8b0d1f3e5a7c9b1d3f5e7a9c'), 200);
});
