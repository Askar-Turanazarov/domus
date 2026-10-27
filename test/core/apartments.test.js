// Apartment status (03 §2, D-15) and sale (03 §8): computed from bookings; sold via booking or office; undo by the head.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock } from '../../server/core/clock.js';
import { statusMap, getApartment, listApartments, markSold, unsell } from '../../server/core/apartments.js';
import { createTestDb, resetDb } from '../support/db.js';
import { makeClient, makeStaff, makeBooking, asStaff, asClient } from '../support/factories.js';

let db, manager, head, client;
const ENV = { TELEGRAM_STAFF_CHAT_ID: '-1' };
before(async () => { db = await createTestDb(); });
after(() => db.close());
beforeEach(async () => {
  await resetDb(db);
  fakeClock.set('2026-10-28T10:00:00+05:00');
  manager = await makeStaff(db);
  head = await makeStaff(db, { login: 'boss', name: 'Руководитель', role: 'head' });
  client = await makeClient(db, { chat: 555 });
});
afterEach(() => fakeClock.reset());

test('status: free → held → booked from bookings; an expired one stops holding at once', async () => {
  assert.equal((await statusMap(db))[41], 'free');
  await makeBooking(db, { apartmentNo: 41, clientId: client.id, status: 'held', minutes: 15 });
  await makeBooking(db, { apartmentNo: 42, clientId: client.id, status: 'booked', minutes: 72 * 60 });
  const m = await statusMap(db);
  assert.equal(m[41], 'held');
  assert.equal(m[42], 'booked');
  assert.equal(Object.keys(m).length, 92);
  fakeClock.advance('15m');
  assert.equal((await statusMap(db))[41], 'free', 'expired, not swept: free');
  assert.equal((await getApartment(db, 42)).status, 'booked');
  assert.deepEqual((await listApartments(db, { status: 'booked' })).map(a => a.no), [42]);
});

test('markSold: booked → booking converted, its jobs cancelled, client and group told', async () => {
  const b = await makeBooking(db, { apartmentNo: 42, clientId: client.id, status: 'booked', minutes: 72 * 60 });
  await db.query(`INSERT INTO jobs (type, run_at, payload, status, created_at, updated_at) VALUES ('booking.expire', $1, $2, 'scheduled', $1, $1)`,
    [b.expires_at, JSON.stringify({ bookingId: b.id })]);
  const apt = await markSold(db, { apartmentNo: 42 }, asStaff(manager), { env: ENV });
  assert.equal(apt.status, 'sold');
  assert.equal(apt.sold_booking_id, b.id);
  assert.equal((await db.one('SELECT status FROM bookings WHERE id = $1', [b.id])).status, 'converted');
  assert.equal((await db.one("SELECT status FROM jobs WHERE type = 'booking.expire'")).status, 'cancelled');
  assert.equal((await statusMap(db))[42], 'sold');
  const out = await db.query('SELECT template, audience, vars FROM outbox ORDER BY id');
  assert.deepEqual(out.map(o => o.template), ['apartment_sold', 'staff_apartment_sold']);
  assert.equal(out[1].vars.staffName, 'Азиз');
  const ev = await db.one("SELECT * FROM events WHERE type = 'apartment.sold'");
  assert.deepEqual(ev.data, { price: apt.price, viaBooking: true });
  assert.equal(ev.staff_id, manager.id);
});

test('markSold: office sale of a free apartment; held / sold / stale / client → errors', async () => {
  const apt = await markSold(db, { apartmentNo: 10, note: 'офис' }, asStaff(head), { env: ENV });
  assert.equal(apt.sold_booking_id, null);
  await assert.rejects(markSold(db, { apartmentNo: 10 }, asStaff(head)), { code: 'apartment_sold' });
  await makeBooking(db, { apartmentNo: 41, clientId: client.id, status: 'held' });
  await assert.rejects(markSold(db, { apartmentNo: 41 }, asStaff(manager)), { code: 'apartment_held' });
  await assert.rejects(markSold(db, { apartmentNo: 11, expectedVersion: 7 }, asStaff(manager)), { code: 'stale' });
  await assert.rejects(markSold(db, { apartmentNo: 11 }, asClient(client)), { code: 'forbidden' });
  await assert.rejects(markSold(db, { apartmentNo: 999 }, asStaff(manager)), { code: 'apartment_not_found' });
});

test('unsell: head only, reason required; the apartment is free, the booking stays converted', async () => {
  const b = await makeBooking(db, { apartmentNo: 42, clientId: client.id, status: 'booked', minutes: 600 });
  await markSold(db, { apartmentNo: 42 }, asStaff(manager), { env: ENV });
  await assert.rejects(unsell(db, { apartmentNo: 42, reason: 'ошибка' }, asStaff(manager)), { code: 'forbidden' });
  await assert.rejects(unsell(db, { apartmentNo: 42, reason: ' ' }, asStaff(head)), { code: 'reason_required' });
  const apt = await unsell(db, { apartmentNo: 42, reason: 'Ошибка менеджера' }, asStaff(head), { env: ENV });
  assert.equal(apt.status, 'free');
  assert.equal((await statusMap(db))[42], 'free');
  assert.equal((await db.one('SELECT status FROM bookings WHERE id = $1', [b.id])).status, 'converted');
  assert.equal((await db.one("SELECT data FROM events WHERE type = 'apartment.unsold'")).data.reason, 'Ошибка менеджера');
});

test('onCommit gets the Outbox rows to deliver; nothing when the transaction fails', async () => {
  const seen = [];
  await markSold(db, { apartmentNo: 12 }, asStaff(head), { env: ENV, onCommit: fx => seen.push(fx) });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].outbox.length, 1);
  await assert.rejects(markSold(db, { apartmentNo: 12 }, asStaff(head), { env: ENV, onCommit: fx => seen.push(fx) }));
  assert.equal(seen.length, 1);
});
