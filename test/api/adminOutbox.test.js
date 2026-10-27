// 12 §6–7, 04 §3.3, 03 §10 (FR-DEMO-01, FR-DEMO-02): the Outbox window and the demo time shift — head only, links masked,
// «send again» for a failed row, the shift with Idempotency-Key and a stale screen — over HTTP with the real staff gate.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { fakeClock, now } from '../../server/core/clock.js';
import { createHold } from '../../server/core/bookings.js';
import { hashPassword } from '../../server/adminAuth.js';
import { createStaff } from '../../server/core/staff.js';
import { mountAdmin } from '../../server/http/admin.js';
import { mountAdminBookings } from '../../server/http/adminBookings.js';
import { mountAdminOutbox } from '../../server/http/adminOutbox.js';
import { requestId, apiErrors } from '../../server/http/common.js';
import { createTestDb, resetDb } from '../support/db.js';
import { makeClient } from '../support/factories.js';

const PASSWORD = 'outbox test password';
const ENV = { LINK_SECRET: 'test-secret', SESSION_SECRET: 'x'.repeat(40), LOG_SALT: 'salt', TELEGRAM_STAFF_CHAT_ID: '-1', PUBLIC_URL: 'https://domus.test' };
const WEB = { type: 'client', id: null, role: 'client', channel: 'web' };
const SIG = 'A'.repeat(32);
let db, server, base, cookies;

before(async () => {
  db = await createTestDb();
  const app = express();
  app.use(requestId);
  const staffAuth = mountAdmin(app, db, { env: ENV, cacheMs: 0 });
  mountAdminBookings(app, db, staffAuth, { env: ENV });
  mountAdminOutbox(app, db, staffAuth, { env: ENV });
  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));
  app.use(apiErrors);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); return db.close(); });

beforeEach(async () => {
  await resetDb(db);
  fakeClock.set('2026-10-28T10:00:00+05:00');
  const passwordHash = await hashPassword(PASSWORD);
  cookies = {};
  for (const role of ['manager', 'head']) {
    await createStaff(db, { login: 'u-' + role, name: role, role, passwordHash });
    const res = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'domus-admin' },
      body: JSON.stringify({ login: 'u-' + role, password: PASSWORD }) });
    assert.equal(res.status, 200);
    cookies[role] = res.headers.get('set-cookie').split(';')[0];
  }
});
afterEach(() => fakeClock.reset());

let n = 0;
async function call(method, path, { role = 'head', body, key } = {}) {
  const headers = { 'X-Requested-With': 'domus-admin' };
  if (role) headers.cookie = cookies[role];
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method === 'POST' && key !== null) headers['Idempotency-Key'] = key ?? `key-${++n}-${Math.random().toString(36).slice(2, 10)}`;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

let seq = 0;
async function row({ status = 'sent', audience = 'client', template = 'booking_confirmed', clientId = null, chatId = 5, skipReason = null, text, keyboard } = {}) {
  fakeClock.advance('1s');
  const rendered = { text: text ?? '<b>Бронь №1042</b>', parse_mode: 'HTML', ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}) };
  return db.one(`INSERT INTO outbox (created_at, audience, chat_id, client_id, template, lang, vars, rendered, status, skip_reason, attempts, dedupe_key, last_error)
    VALUES ($1, $2, $3, $4, $5, 'ru', '{"secret":"v"}', $6, $7, $8, 1, $9, $10) RETURNING *`,
  [now(), audience, chatId, clientId, template, rendered, status, skipReason, `k${++seq}`, status === 'failed' ? 'HTTP 500 boom' : null]);
}

test('the window is for the head only', async () => {
  const r = await row();
  for (const [m, p] of [['GET', '/api/admin/outbox'], ['GET', `/api/admin/outbox/${r.id}`], ['POST', `/api/admin/outbox/${r.id}/resend`], ['POST', '/api/admin/bookings/1/shift']]) {
    const o = m === 'GET' ? {} : { body: {} };
    assert.equal((await call(m, p, { role: null, ...o })).status, 401, p);
    assert.equal((await call(m, p, { role: 'manager', ...o })).status, 403, p);
  }
});

test('the list: newest first, filters, cursor; neither template variables nor chat ids leave', async () => {
  const c = await makeClient(db, { name: 'Дилноза', phone: '+998901234567', tg: 5 });
  const a = await row({ clientId: c.id, template: 'hold_created' });
  const b = await row({ status: 'failed', clientId: c.id });
  const g = await row({ audience: 'staff_group', template: 'staff_booking_paid', chatId: -1 });
  const s = await row({ status: 'skipped', skipReason: 'no_telegram', chatId: null, clientId: c.id });

  const all = (await call('GET', '/api/admin/outbox')).body;
  assert.deepEqual(all.items.map(i => i.id), [s.id, g.id, b.id, a.id].map(Number));
  assert.equal(all.next, null);
  const first = all.items[3];
  assert.equal(first.recipient.kind, 'client');
  assert.equal(first.recipient.name, 'Дилноза');
  assert.equal(first.template, 'hold_created');
  assert.ok(!JSON.stringify(all).includes('secret'));
  assert.ok(!JSON.stringify(all).includes('chat_id'));
  assert.deepEqual(all.items.map(i => i.canResend), [false, false, true, false]);

  const ids = r => r.body.items.map(i => i.id);
  assert.deepEqual(ids(await call('GET', '/api/admin/outbox?status=failed')), [Number(b.id)]);
  assert.deepEqual(ids(await call('GET', '/api/admin/outbox?target=staff_group')), [Number(g.id)]);
  assert.deepEqual(ids(await call('GET', '/api/admin/outbox?template=hold_created')), [Number(a.id)]);
  assert.equal((await call('GET', '/api/admin/outbox?status=nope')).status, 400);
  assert.equal((await call('GET', '/api/admin/outbox?cursor=zzz')).status, 400);

  const seen = [];
  let cursor = '';
  for (let page = 0; page < 4; page++) {
    const r = (await call('GET', `/api/admin/outbox?limit=3${cursor}`)).body;
    seen.push(...r.items.map(i => i.id));
    if (!r.next) break;
    cursor = `&cursor=${encodeURIComponent(r.next)}`;
  }
  assert.deepEqual(seen, [s.id, g.id, b.id, a.id].map(Number));
});

test('the card: the bot HTML and buttons as sent, the personal link masked', async () => {
  const r = await row({
    text: `Ваша бронь: <a href="https://domus.test/b/1042-${SIG}">открыть</a>`,
    keyboard: [[{ text: 'Открыть бронь', web_app: { url: `https://domus.test/b/1042-${SIG}` } }], [{ text: 'Сайт', url: 'https://domus.test/' }, { text: 'Продлить', callback_data: 'x:1' }]]
  });
  const card = (await call('GET', `/api/admin/outbox/${r.id}`)).body;
  assert.equal(card.status, 'sent');
  assert.match(card.preview.html, /\/b\/1042-••••/);
  assert.ok(!JSON.stringify(card).includes(SIG));
  assert.deepEqual(card.preview.buttons.map(b => [b.text, b.kind]), [['Открыть бронь', 'web_app'], ['Сайт', 'link'], ['Продлить', 'action']]);
  assert.match(card.preview.buttons[0].target, /••••$/);
  assert.equal(card.preview.buttons[2].target, null);
  assert.ok(!('vars' in card));
  assert.equal((await call('GET', '/api/admin/outbox/999999')).status, 404);
  assert.equal((await call('GET', '/api/admin/outbox/abc')).status, 404);
});

test('send again: a failed row goes back to retry; a sent one cannot; a blocked one can', async () => {
  const failed = await row({ status: 'failed' });
  const sent = await row({ status: 'sent' });
  const blocked = await row({ status: 'skipped', skipReason: 'blocked' });
  const noTg = await row({ status: 'skipped', skipReason: 'no_telegram', chatId: null });

  // resend needs no key: a second tap on a row already in retry is a harmless repeat
  const r = await call('POST', `/api/admin/outbox/${failed.id}/resend`, { body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'retry');
  const now0 = await db.one('SELECT status, next_attempt_at FROM outbox WHERE id = $1', [failed.id]);
  assert.equal(now0.status, 'retry');
  assert.equal(now0.next_attempt_at.getTime(), now().getTime());

  assert.equal((await call('POST', `/api/admin/outbox/${blocked.id}/resend`, { body: {} })).status, 200);
  for (const x of [sent, noTg]) assert.equal((await call('POST', `/api/admin/outbox/${x.id}/resend`, { body: {} })).status, 400);
  assert.equal((await call('POST', '/api/admin/outbox/999999/resend', { body: {} })).status, 404);
});

test('shift: the head moves a deadline; a stale screen gets the current booking; the key replays', async () => {
  const { booking } = await createHold(db, { apartmentNo: 41, client: { name: 'Дилноза Р.', phone: '+998901234567' }, consent: { version: '2026-10-27' }, channel: 'web' }, WEB, { env: ENV });
  const path = `/api/admin/bookings/${booking.no}/shift`;
  const body = { target: 'hold_1m', expectedVersion: booking.version };

  assert.equal((await call('POST', path, { body, key: null })).status, 400);
  assert.equal((await call('POST', path, { body: { ...body, target: 'hold_2m' } })).status, 400);
  assert.equal((await call('POST', path, { body: { target: 'hold_1m' } })).status, 400);
  assert.equal((await call('POST', `/api/admin/bookings/99999/shift`, { body })).status, 404);

  const first = await call('POST', path, { body, key: 'shift-key-0001' });
  assert.equal(first.status, 200);
  assert.equal(new Date(first.body.booking.expiresAt).getTime(), now().getTime() + 60e3);
  assert.equal(first.body.booking.version, booking.version + 1);
  assert.deepEqual((await call('POST', path, { body, key: 'shift-key-0001' })).body, first.body);
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM events WHERE type = 'demo.time_shifted'`)).n, 1);

  const old = await call('POST', path, { body });
  assert.equal(old.status, 409);
  assert.equal(old.body.error, 'stale');
  assert.equal(old.body.vars.current.version, booking.version + 1);

  const wrong = await call('POST', path, { body: { target: 'booking_1m', expectedVersion: booking.version + 1 } });          // a hold is not a booking
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.error, 'booking_not_active');
});
