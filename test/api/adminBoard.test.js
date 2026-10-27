// 12 §3, 13 §9.2: the chessboard (GET /api/admin/units) and the apartment card (GET /api/admin/apartments/:no) over HTTP —
// rights, the statuses the showcase shows, «burns within 24 h», masks instead of personal data, history of the apartment.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { fakeClock, now } from '../../server/core/clock.js';
import { statusMap } from '../../server/core/apartments.js';
import { emit } from '../../server/core/events.js';
import { hashPassword } from '../../server/adminAuth.js';
import { createStaff } from '../../server/core/staff.js';
import { mountAdmin } from '../../server/http/admin.js';
import { mountAdminBoard } from '../../server/http/adminBoard.js';
import { requestId, apiErrors } from '../../server/http/common.js';
import { createTestDb, resetDb } from '../support/db.js';
import { makeClient, makeBooking } from '../support/factories.js';

const PASSWORD = 'board test password';
const PHONE = '+998901234567';
let db, server, base, cookies;

before(async () => {
  db = await createTestDb();
  const app = express();
  app.use(requestId);
  mountAdmin(app, db, { env: { SESSION_SECRET: 'x'.repeat(40), LOG_SALT: 'salt' }, cacheMs: 0 });
  mountAdminBoard(app, db);
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

const get = (path, role = 'manager') => fetch(base + path, { headers: role ? { cookie: cookies[role] } : {} });

test('without a session both entries answer 401', async () => {
  assert.equal((await get('/api/admin/units', null)).status, 401);
  assert.equal((await get('/api/admin/apartments/41', null)).status, 401);
});

test('the board: all apartments, the statuses of the showcase, the 24-hour mark, no personal data', async () => {
  const c = await makeClient(db, { name: 'Дилноза', phone: PHONE });
  await makeBooking(db, { apartmentNo: 41, clientId: c.id, status: 'held', minutes: 15 });
  const soon = await makeBooking(db, { apartmentNo: 42, clientId: c.id, status: 'booked', minutes: 120 });
  await makeBooking(db, { apartmentNo: 43, clientId: c.id, status: 'booked', minutes: 3 * 24 * 60 });
  await makeBooking(db, { apartmentNo: 45, clientId: c.id, status: 'held', minutes: -5 });   // expired but not yet swept: free
  await db.query('UPDATE apartments SET sold_at = $1 WHERE no = 44', [now()]);

  for (const role of ['manager', 'head']) {
    const res = await get('/api/admin/units', role);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const { units, at } = await res.json();
    assert.match(at, /\+05:00$/);
    assert.equal(units.length, 92);
    const by = Object.fromEntries(units.map(u => [u.no, u]));
    assert.equal(by[41].status, 'held');
    assert.equal(by[42].status, 'booked');
    assert.equal(by[44].status, 'sold');
    assert.equal(by[45].status, 'free');
    assert.equal(by[1].status, 'free');
    assert.equal(by[42].soon, true);                       // 2 h left
    assert.equal(by[43].soon, false);                      // 3 days left
    assert.equal(by[41].soon, false);                      // a hold is minutes, not «burning»
    assert.equal(by[42].bookingNo, soon.no);
    assert.ok(by[42].expiresAt && by[1].expiresAt === undefined);
    assert.deepEqual(Object.keys(by[1]).sort(), ['area', 'floor', 'no', 'price', 'rooms', 'soon', 'status']);
    // the same statuses as the showcase
    assert.deepEqual(Object.fromEntries(units.map(u => [u.no, u.status])), await statusMap(db));
    const text = JSON.stringify(units);
    assert.ok(!text.includes('Дилноза') && !text.includes('998901234567'));
  }
});

test('the card: the booking that holds the apartment, all bookings, viewings, history; the phone only as a mask', async () => {
  const c = await makeClient(db, { name: 'Дилноза Р.', phone: PHONE, tg: 777 });
  const old = await makeBooking(db, { apartmentNo: 41, clientId: c.id, status: 'held', minutes: -60 });
  await db.query(`UPDATE bookings SET status = 'hold_expired', closed_at = $2 WHERE id = $1`, [old.id, now()]);
  const cur = await makeBooking(db, { apartmentNo: 41, clientId: c.id, status: 'booked', minutes: 2 * 24 * 60 });
  await db.query(`INSERT INTO viewings (apartment_no, client_id, at, name, phone, status, channel, created_by, created_at, updated_at)
    VALUES (41, $1, $2, 'Дилноза Р.', $3, 'scheduled', 'telegram', '{"type":"client"}', $2, $2)`, [c.id, new Date('2026-10-29T10:00:00+05:00'), PHONE]);
  await emit(db, 'booking.held', { apartmentNo: 41, bookingId: cur.id, clientId: c.id }, { minutes: 15 }, { type: 'client', id: c.id });
  await emit(db, 'booking.paid', { apartmentNo: 41, bookingId: cur.id, clientId: c.id }, { amount: 10000000 }, { type: 'system' });

  const res = await get('/api/admin/apartments/41');
  assert.equal(res.status, 200);
  const card = await res.json();
  assert.equal(card.apartment.no, 41);
  assert.equal(card.apartment.status, 'booked');
  assert.equal(typeof card.apartment.version, 'number');
  assert.equal(card.booking.no, cur.no);
  assert.equal(card.booking.client.name, 'Дилноза Р.');
  assert.equal(card.booking.client.telegramLinked, true);
  assert.notEqual(card.booking.client.phone, PHONE);
  assert.match(card.booking.client.phone, /\*/);
  assert.deepEqual(card.bookings.map(b => b.no), [cur.no, old.no].sort((a, b) => b - a));   // newest first
  assert.equal(card.viewings.length, 1);
  assert.match(card.viewings[0].phone, /\*/);
  assert.deepEqual(card.history.map(e => e.type), ['booking.paid', 'booking.held']);          // newest first
  assert.equal(card.history[0].bookingNo, cur.no);
  assert.ok(!JSON.stringify(card).includes('998901234567'));
});

test('the card of a free apartment has no current booking; an unknown or junk number → 404', async () => {
  const card = await (await get('/api/admin/apartments/7', 'head')).json();
  assert.equal(card.booking, null);
  assert.deepEqual(card.bookings, []);
  assert.equal(card.apartment.status, 'free');
  for (const p of ['/api/admin/apartments/9999', '/api/admin/apartments/0', '/api/admin/apartments/abc', '/api/admin/apartments/4.5']) {
    const res = await get(p);
    assert.equal(res.status, 404, p);
    assert.equal((await res.json()).error, 'apartment_not_found');
  }
});
