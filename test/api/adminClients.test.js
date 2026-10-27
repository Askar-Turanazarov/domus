// 12 §5, §12.3, 13 §9.3 (FR-ADM-06, FR-CRM-01…03): the list with filters / search / cursor and only masks, the card with bookings, payments,
// dialogs and merges, the full phone on request with a journal entry and no number in it, taking a client, the feed of a dialog, the
// Telegram link of the signed-in staff member — over HTTP with the real staff gate.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { fakeClock, now } from '../../server/core/clock.js';
import { createHold } from '../../server/core/bookings.js';
import { startPayment } from '../../server/core/payments.js';
import { submitCard, confirmCard } from '../../server/payments/card.js';
import { hashPassword } from '../../server/adminAuth.js';
import { createStaff, attachStaffTelegram } from '../../server/core/staff.js';
import { merge } from '../../server/core/clients.js';
import { mountAdmin } from '../../server/http/admin.js';
import { mountAdminClients } from '../../server/http/adminClients.js';
import { requestId, apiErrors } from '../../server/http/common.js';
import { createTestDb, resetDb } from '../support/db.js';
import { makeClient, makeBooking } from '../support/factories.js';

const PASSWORD = 'clients test password';
const ENV = { LINK_SECRET: 'test-secret', SESSION_SECRET: 'x'.repeat(40), LOG_SALT: 'salt', TELEGRAM_STAFF_CHAT_ID: '-1', PUBLIC_URL: 'https://domus.test',
  TELEGRAM_BOT_USERNAME: 'ChinorParkBot', TELEGRAM_BOT_TOKEN: 'test-token' };
const SYSTEM = { type: 'system' };
const WEB = { type: 'client', id: null, role: 'client', channel: 'web' };
const DAY = 24 * 3600e3;
const ago = ms => new Date(now().getTime() - ms);
const NOBODY = '11111111-1111-4111-8111-111111111111';
let db, server, base, cookies, staff;

before(async () => {
  db = await createTestDb();
  const app = express();
  app.use(requestId);
  const staffAuth = mountAdmin(app, db, { env: ENV, cacheMs: 0 });
  mountAdminClients(app, db, staffAuth, { env: ENV });
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
  cookies = {}; staff = {};
  for (const role of ['manager', 'head']) {
    staff[role] = await createStaff(db, { login: 'u-' + role, name: role === 'manager' ? 'Азиз' : 'Мадина', role, passwordHash });
    const res = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'domus-admin' },
      body: JSON.stringify({ login: 'u-' + role, password: PASSWORD }) });
    assert.equal(res.status, 200);
    cookies[role] = res.headers.get('set-cookie').split(';')[0];
  }
});
afterEach(() => fakeClock.reset());

async function call(method, path, { role = 'manager', body } = {}) {
  const headers = { 'X-Requested-With': 'domus-admin' };
  if (role) headers.cookie = cookies[role];
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
}
const dialog = async (clientId, { mode = 'ai', channel = 'telegram', texts = [] } = {}) => {
  const conv = await db.one(`INSERT INTO conversations (kind, client_id, channel, lang, mode, message_count, created_at, updated_at, last_message_at)
    VALUES ('client', $1, $2, 'ru', $3, $4, $5, $5, $5) RETURNING *`, [clientId, channel, mode, texts.length, now()]);
  for (const [role, text] of texts) await db.query('INSERT INTO messages (conversation_id, role, text, created_at) VALUES ($1, $2, $3, $4)', [conv.id, role, text, now()]);
  return conv;
};

test('without a session every entry answers 401', async () => {
  for (const p of ['/api/admin/clients', '/api/admin/clients/x', '/api/admin/conversations/x']) assert.equal((await call('GET', p, { role: null })).status, 401, p);
  for (const p of ['/api/admin/clients/x/reveal-phone', '/api/admin/clients/x/assign', '/api/admin/me/telegram-link']) {
    assert.equal((await call('POST', p, { role: null, body: {} })).status, 401, p);
  }
  assert.equal((await call('DELETE', '/api/admin/me/telegram', { role: null })).status, 401);
});

test('the list: masks only, filters (score, mine, waiting, active), search by name / phone / @name, latest activity first, cursor', async () => {
  const hot = await makeClient(db, { name: 'Дилноза', phone: '+998901234567', tg: 5 });
  const cold = await makeClient(db, { name: 'Бобур', phone: '+998935550011' });
  const anon = await makeClient(db, { name: null });
  await db.query(`UPDATE clients SET lead_score = 'hot', telegram_username = 'dilnoza_r', assigned_staff_id = $2, last_seen_at = $3 WHERE id = $1`, [hot.id, staff.manager.id, ago(60e3)]);
  await db.query(`UPDATE clients SET lead_score = 'cold', last_seen_at = $2 WHERE id = $1`, [cold.id, ago(DAY)]);
  await db.query('UPDATE clients SET last_seen_at = $2 WHERE id = $1', [anon.id, ago(3 * DAY)]);
  await dialog(cold.id, { mode: 'human' });
  await makeBooking(db, { apartmentNo: 41, clientId: hot.id, status: 'booked', minutes: 60 });
  await makeBooking(db, { apartmentNo: 42, clientId: cold.id, status: 'booked', minutes: -5 });       // past the deadline: not active

  const list = async (qs = '', role = 'manager') => (await call('GET', `/api/admin/clients${qs}`, { role })).body;
  const ids = r => r.items.map(i => i.id);

  const all = await list();
  assert.deepEqual(ids(all), [hot.id, cold.id, anon.id]);
  assert.equal(all.next, null);
  assert.match(all.at, /\+05:00$/);
  const row = all.items[0];
  assert.equal(row.phone, '+998 90 *** ** 67');
  assert.deepEqual([row.leadScore, row.assignee, row.telegramUsername, row.hasActiveBooking, row.waiting],
    ['hot', { id: staff.manager.id, name: 'Азиз' }, 'dilnoza_r', true, false]);
  assert.equal(all.items[1].waiting, true);
  assert.ok(!JSON.stringify(all).includes('1234567'), 'no full number in the list');

  assert.deepEqual(ids(await list('?score=hot')), [hot.id]);
  assert.deepEqual(ids(await list('?mine=1')), [hot.id]);
  assert.deepEqual(ids(await list('?mine=1', 'head')), []);
  assert.deepEqual(ids(await list('?waiting=1')), [cold.id]);
  assert.deepEqual(ids(await list('?active=1')), [hot.id]);
  assert.deepEqual(ids(await list('?waiting=1&score=hot')), []);
  assert.deepEqual(ids(await list('?q=' + encodeURIComponent('Бобур'))), [cold.id]);
  assert.deepEqual(ids(await list('?q=%2B998%2090%20123')), [hot.id]);
  assert.deepEqual(ids(await list('?q=%40dilnoza')), [hot.id]);
  assert.deepEqual(ids(await list('?q=%25')), [], 'a wildcard is only text');

  const first = await list('?limit=2');
  assert.deepEqual(ids(first), [hot.id, cold.id]);
  assert.ok(first.next);
  assert.deepEqual(ids(await list('?limit=2&cursor=' + first.next)), [anon.id]);
  assert.equal((await call('GET', '/api/admin/clients?cursor=junk')).status, 400);
  assert.equal((await call('GET', '/api/admin/clients?score=lukewarm')).status, 400);
});

test('the card: contacts as a mask, bookings, payments, dialogs, merges — and a merged card answers with the card it became', async () => {
  const { booking } = await createHold(db, { apartmentNo: 41, client: { name: 'Дилноза Р.', phone: '+998901234567' }, consent: { version: '2026-10-27' }, channel: 'web' }, WEB, { env: ENV });
  const { paymentId } = await startPayment(db, { target: { bookingId: booking.id }, provider: 'card' }, WEB, { env: ENV });
  const { sms } = await submitCard(db, { paymentId, number: '9860 0000 0009 0001', expiry: '12/29' }, { env: ENV });
  await confirmCard(db, { paymentId, code: sms.code }, { env: ENV });
  const c = await db.one('SELECT * FROM clients WHERE id = $1', [booking.client_id]);
  await db.query(`UPDATE clients SET lead_score = 'warm', lead_summary = 'Смотрит двушки', lead_next_step = 'Позвонить', lead_scored_at = $2, telegram_username = 'dilnoza_r' WHERE id = $1`, [c.id, now()]);
  const conv = await dialog(c.id, { texts: [['user', 'Есть двушки?'], ['assistant', 'Да, три варианта.']] });
  await db.query(`INSERT INTO viewings (apartment_no, client_id, at, name, phone, status, channel, created_by, created_at, updated_at)
    VALUES (41, $1, $2, 'Дилноза', '+998901234567', 'scheduled', 'web', '{}', $3, $3)`, [c.id, new Date(now().getTime() + DAY), now()]);
  const other = await makeClient(db, { name: 'Dilnoza', channel: 'telegram', tg: 77 });
  await db.tx(q => merge(q, other.id, c.id, 'R1', SYSTEM, { env: ENV }));

  const r = await call('GET', `/api/admin/clients/${c.id}`);
  assert.equal(r.status, 200);
  const card = r.body;
  assert.equal(card.client.phone, '+998 90 *** ** 67');
  assert.equal(card.client.hasPhone, true);
  assert.deepEqual([card.client.telegramUsername, card.client.lead.score, card.client.lead.summary, card.client.assignee],
    ['dilnoza_r', 'warm', 'Смотрит двушки', null]);
  assert.deepEqual(card.bookings.map(b => [b.no, b.status, b.apartment.no]), [[booking.no, 'booked', 41]]);
  assert.deepEqual(card.payments.map(p => [p.status, p.bookingNo, p.cardBrand]), [['succeeded', booking.no, 'HUMO']]);
  assert.equal(card.viewings.length, 1);
  assert.deepEqual(card.dialogs.map(d => [d.id, d.channel, d.mode, d.messageCount]), [[conv.id, 'telegram', 'ai', 2]]);
  assert.deepEqual(card.merges.map(m => [m.rule, m.fromChannel]), [['R1', 'telegram']]);
  assert.ok(!JSON.stringify(card).includes('1234567'), 'no full number in the card');
  assert.ok(!JSON.stringify(card).includes('9860 0000'), 'no card number');

  assert.equal((await call('GET', `/api/admin/clients/${other.id}`)).body.client.id, c.id);
  assert.equal((await call('GET', '/api/admin/clients/not-an-id')).status, 404);
  assert.equal((await call('GET', `/api/admin/clients/${NOBODY}`)).status, 404);
});

test('«show the number»: the full phone for staff, a journal entry without the number, 404 for a stranger', async () => {
  const c = await makeClient(db, { name: 'Дилноза', phone: '+998901234567' });
  const none = await makeClient(db, { name: 'Аноним' });
  const r = await call('POST', `/api/admin/clients/${c.id}/reveal-phone`, { role: 'head', body: {} });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { phone: '+998901234567' });
  const ev = await db.query(`SELECT * FROM events WHERE type = 'client.phone_revealed'`);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].client_id, c.id);
  assert.equal(ev[0].staff_id, staff.head.id);
  assert.ok(!JSON.stringify(ev[0]).includes('1234567'), 'the journal holds no number');
  assert.deepEqual((await call('POST', `/api/admin/clients/${none.id}/reveal-phone`, { body: {} })).body, { phone: null });
  assert.equal((await call('POST', `/api/admin/clients/${NOBODY}/reveal-phone`, { body: {} })).status, 404);
  assert.equal((await call('POST', `/api/admin/clients/${c.id}/reveal-phone`, { body: { extra: 1 } })).status, 400);
  assert.equal((await db.query(`SELECT 1 FROM events WHERE type = 'client.phone_revealed'`)).length, 2, 'every press is written, a refused one is not');
});

test('«take for myself»: the first takes, the second sees who has the client; unknown staff and junk are refused', async () => {
  const c = await makeClient(db, { name: 'Дилноза', phone: '+998901234567' });
  const first = await call('POST', `/api/admin/clients/${c.id}/assign`, { role: 'manager', body: { staffId: 'me' } });
  assert.equal(first.status, 200);
  assert.equal(first.body.taken, true);
  assert.deepEqual(first.body.client.assignee, { id: staff.manager.id, name: 'Азиз' });
  const second = await call('POST', `/api/admin/clients/${c.id}/assign`, { role: 'head', body: { staffId: 'me' } });
  assert.equal(second.status, 200);
  assert.equal(second.body.taken, false);
  assert.deepEqual(second.body.client.assignee, { id: staff.manager.id, name: 'Азиз' });
  assert.equal((await db.query(`SELECT 1 FROM events WHERE type = 'client.assigned'`)).length, 1);

  const free = await makeClient(db, { name: 'Бобур' });
  assert.equal((await call('POST', `/api/admin/clients/${free.id}/assign`, { body: { staffId: NOBODY } })).status, 404);
  assert.equal((await call('POST', `/api/admin/clients/${free.id}/assign`, { body: { staffId: 'everyone' } })).status, 400);
  assert.equal((await call('POST', `/api/admin/clients/${free.id}/assign`, { body: {} })).status, 400);
  const byManager = await call('POST', `/api/admin/clients/${free.id}/assign`, { role: 'manager', body: { staffId: staff.head.id } });
  assert.equal(byManager.body.client.assignee.name, 'Мадина');
});

test('a dialog: the feed with roles, only after the given message, never an analyst dialog', async () => {
  const c = await makeClient(db, { name: 'Дилноза' });
  const conv = await dialog(c.id, { texts: [['user', 'Есть двушки?'], ['assistant', 'Да.'], ['staff', 'Здравствуйте, это Азиз']] });
  const r = (await call('GET', `/api/admin/conversations/${conv.id}`)).body;
  assert.deepEqual(r.messages.map(m => [m.role, m.text]), [['user', 'Есть двушки?'], ['assistant', 'Да.'], ['staff', 'Здравствуйте, это Азиз']]);
  assert.deepEqual([r.conversation.channel, r.conversation.mode, r.conversation.clientId], ['telegram', 'ai', c.id]);
  const rest = (await call('GET', `/api/admin/conversations/${conv.id}?after=${r.messages[1].id}`)).body;
  assert.deepEqual(rest.messages.map(m => m.role), ['staff']);

  const mine = await db.one(`INSERT INTO conversations (kind, staff_id, channel, lang, created_at, updated_at) VALUES ('analyst', $1, 'admin', 'ru', $2, $2) RETURNING id`,
    [staff.head.id, now()]);
  assert.equal((await call('GET', `/api/admin/conversations/${mine.id}`)).status, 404);
  const miss = await call('GET', `/api/admin/conversations/${NOBODY}`);
  assert.equal(miss.status, 404);
  assert.equal(miss.body.error, 'conversation_not_found');
  assert.equal((await call('GET', '/api/admin/conversations/nope')).status, 404);
});

test('the Telegram link of a staff member: a 15-minute code in a t.me link, the bot joins it, «unlink» clears it', async () => {
  const me = async () => (await call('GET', '/api/admin/me')).body.staff;
  assert.equal((await me()).telegramLinked, false);
  const r = await call('POST', '/api/admin/me/telegram-link', { body: {} });
  assert.equal(r.status, 200);
  const m = /^https:\/\/t\.me\/ChinorParkBot\?start=st_([\w-]+)$/.exec(r.body.url);
  assert.ok(m, r.body.url);
  assert.equal(new Date(r.body.expiresAt).getTime(), now().getTime() + 15 * 60e3);
  assert.ok(!(await db.one('SELECT tg_link_code_hash AS h FROM staff WHERE id = $1', [staff.manager.id])).h.includes(m[1]), 'only the hash is stored');

  await attachStaffTelegram(db, { code: m[1], telegram: { userId: 4242, username: 'aziz' } }, { env: ENV });
  assert.equal((await me()).telegramLinked, true);
  assert.equal((await call('POST', '/api/admin/me/telegram-link', { role: 'head', body: { x: 1 } })).status, 400);

  const del = await call('DELETE', '/api/admin/me/telegram');
  assert.equal(del.status, 204);
  assert.equal((await me()).telegramLinked, false);
  assert.equal((await db.one('SELECT telegram_user_id FROM staff WHERE id = $1', [staff.manager.id])).telegram_user_id, null);
  assert.equal((await db.query(`SELECT 1 FROM events WHERE type = 'staff.telegram_unlinked' AND staff_id = $1`, [staff.manager.id])).length, 1);
  await assert.rejects(attachStaffTelegram(db, { code: m[1], telegram: { userId: 4242 } }, { env: ENV }), /link_invalid/, 'a used code does not work again');
});

test('the Telegram link is limited to 5 an hour per person', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/admin/me/telegram-link', { body: {} })).status, 200);
  assert.equal((await call('POST', '/api/admin/me/telegram-link', { body: {} })).status, 429);
  assert.equal((await call('POST', '/api/admin/me/telegram-link', { role: 'head', body: {} })).status, 200, 'another person has his own limit');
});
