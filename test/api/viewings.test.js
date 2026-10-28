// Viewings over HTTP (13 §5, §7, 11 §7.2): the slot grid of a day, the site form (client by phone + dcl, the honeypot, the
// limits, a repeat with the same key), the mini app with the client of initData. Sold apartments and past times are refused.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { fakeClock, now as clockNow } from '../../server/core/clock.js';
import { requestId, noStore, apiErrors } from '../../server/http/common.js';
import { mountViewings } from '../../server/http/viewings.js';
import { mountMini } from '../../server/http/mini.js';
import { signInitData } from '../../server/telegram/initData.js';
import { createTestDb, resetDb } from '../support/db.js';
import { ENV } from '../support/api.js';

const TOKEN = '123456:TEST';
const E = { ...ENV, TELEGRAM_BOT_TOKEN: TOKEN };
let db, server, base;

before(async () => {
  db = await createTestDb();
  const app = express();
  app.use(requestId);
  app.use('/api', noStore);
  mountViewings(app, db, { env: E });
  mountMini(app, db, { env: E, buildings: { get: async () => null }, buildingId: 'chinor' });
  app.use(apiErrors);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await db.close(); });
beforeEach(async () => { await resetDb(db); fakeClock.set('2026-10-28T10:10:00+05:00'); });
afterEach(() => fakeClock.reset());

const tg = () => signInitData({ auth_date: String(Math.floor(clockNow().getTime() / 1000)), user: { id: 77, first_name: 'Аня' } }, TOKEN);

async function call(method, url, body, { key = crypto.randomUUID(), headers = {} } = {}) {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(method === 'POST' ? { 'idempotency-key': key } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
}
const form = (over = {}) => ({ apartmentNo: 41, at: '2026-10-29T15:00', name: 'Борис', phone: '+998 90 123 45 67', lang: 'ru', ...over });

test('slots: 09:00…19:30 by 30 min; past ones of today are not free; beyond 14 days or before today → 422', async () => {
  const r = await call('GET', '/api/viewings/slots?no=41&date=2026-10-28');
  assert.equal(r.status, 200);
  assert.equal(r.body.slots.length, 22);
  assert.deepEqual([r.body.slots[0], r.body.slots.at(-1).at], [{ at: '09:00', free: false }, '19:30']);
  assert.equal(r.body.slots.find(s => s.at === '10:30').free, true);
  assert.equal((await call('GET', '/api/viewings/slots?no=41&date=2026-11-11')).status, 422);
  assert.equal((await call('GET', '/api/viewings/slots?no=41&date=2026-10-27')).status, 422);
  assert.equal((await call('GET', '/api/viewings/slots?no=99999&date=2026-10-29')).status, 404);
});

test('site form: 201, the client by phone with a dcl cookie, the slot turns grey; a repeat with the same key → the same viewing', async () => {
  const key = crypto.randomUUID();
  const r = await call('POST', '/api/viewings', form(), { key });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.viewing.apartmentNo, r.body.viewing.local], [41, '2026-10-29 15:00']);
  assert.match(r.headers.get('set-cookie') ?? '', /dcl=/);
  const again = await call('POST', '/api/viewings', form(), { key });
  assert.deepEqual([again.status, again.body.viewing.id], [201, r.body.viewing.id]);
  const v = await db.one('SELECT v.*, c.phone AS cphone FROM viewings v JOIN clients c ON c.id = v.client_id');
  assert.deepEqual([v.channel, v.cphone, v.status], ['web', '+998901234567', 'scheduled']);
  const slots = await call('GET', '/api/viewings/slots?no=41&date=2026-10-29');
  assert.equal(slots.body.slots.find(s => s.at === '15:00').free, false);
  const other = await call('POST', '/api/viewings', form({ name: 'Вера', phone: '+998901111111' }));
  assert.deepEqual([other.status, other.body.error], [409, 'slot_taken']);
});

test('site form: honeypot → fake 201, nothing written; no phone, past time, outside hours, sold → errors', async () => {
  assert.equal((await call('POST', '/api/viewings', form({ website: 'x' }))).status, 201);
  assert.equal((await db.one('SELECT count(*)::int AS n FROM viewings')).n, 0);
  assert.equal((await call('POST', '/api/viewings', form({ phone: undefined }))).body.error, 'need_phone');
  assert.equal((await call('POST', '/api/viewings', form({ at: '2026-10-28T09:30' }))).body.error, 'datetime_past');
  assert.equal((await call('POST', '/api/viewings', form({ at: '2026-10-29T20:30' }))).body.error, 'outside_hours');
  assert.equal((await call('POST', '/api/viewings', { ...form(), extra: 1 })).body.error, 'invalid_input');
  await db.query('UPDATE apartments SET sold_at = $1 WHERE no = 41', [clockNow()]);
  assert.equal((await call('POST', '/api/viewings', form())).body.error, 'apartment_sold');
  assert.ok((await call('GET', '/api/viewings/slots?no=41&date=2026-10-29')).body.slots.every(s => !s.free));
});

test('mini: slots and a viewing with the client of initData (channel mini); no phone on the card and none in the body → need_phone', async () => {
  const h = { headers: { 'x-tg-init-data': tg() } };
  assert.equal((await call('GET', '/api/mini/viewings/slots?no=41&date=2026-10-29', undefined, h)).status, 200);
  assert.equal((await call('GET', '/api/mini/viewings/slots?no=41&date=2026-10-29')).status, 401);
  assert.equal((await call('POST', '/api/mini/viewings', { apartmentNo: 41, at: '2026-10-29T16:00' }, h)).body.error, 'need_phone');
  const r = await call('POST', '/api/mini/viewings', { apartmentNo: 41, at: '2026-10-29T16:00', phone: '+998907777777', name: 'Аня' }, h);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const v = await db.one('SELECT v.channel, c.telegram_user_id, c.phone FROM viewings v JOIN clients c ON c.id = v.client_id');
  assert.deepEqual([v.channel, Number(v.telegram_user_id), v.phone], ['mini', 77, '+998907777777']);
  assert.equal((await call('POST', '/api/mini/viewings', { apartmentNo: 41, at: '2026-10-29T16:30' }, h)).status, 201, 'the phone is on the card now');
});
