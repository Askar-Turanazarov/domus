// Core events (04 §2, §8): emit with refs, the dashboard feed with its 15-second window, a booking's history.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock } from '../../server/core/clock.js';
import { emit, feed, history } from '../../server/core/events.js';
import { createTestDb, resetDb } from '../support/db.js';

let db;
before(async () => { db = await createTestDb(); });
after(() => db.close());
beforeEach(async () => { await resetDb(db); fakeClock.set('2026-10-28T10:00:00+05:00'); });
afterEach(() => fakeClock.reset());

test('emit: refs to columns, actor and data as JSON, time from the clock', async () => {
  const id = await emit(db, 'booking.held', { apartmentNo: 41 }, { deposit: 10_000_000 }, { type: 'client', channel: 'web' }, { requestId: 'r1' });
  const e = await db.one('SELECT * FROM events WHERE id = $1', [id]);
  assert.equal(e.type, 'booking.held');
  assert.equal(e.apartment_no, 41);
  assert.deepEqual(e.actor, { type: 'client', channel: 'web' });
  assert.deepEqual(e.data, { deposit: 10_000_000 });
  assert.equal(e.request_id, 'r1');
  assert.equal(e.at.toISOString(), '2026-10-28T05:00:00.000Z');
});

test('feed: feed types only, after the cursor, plus the last 15 s whatever the id; newest first', async () => {
  const a = await emit(db, 'booking.held', { apartmentNo: 1 });
  await emit(db, 'booking.released', { apartmentNo: 1 });          // not a feed type
  const b = await emit(db, 'booking.paid', { apartmentNo: 2 });
  assert.deepEqual((await feed(db, { after: b })).map(e => e.id), [b, a], 'within 15 s: both, even below the cursor');
  fakeClock.advance('16s');
  const c = await emit(db, 'apartment.sold', { apartmentNo: 3 });
  assert.deepEqual((await feed(db, { after: b })).map(e => e.id), [c]);
  assert.deepEqual((await feed(db, { after: 0 })).map(e => e.id), [c, b, a]);
});

test('history: a booking\'s events and its payments\' events, in time order', async () => {
  const bk = '00000000-0000-4000-8000-000000000001';
  const other = '00000000-0000-4000-8000-000000000002';
  const e1 = await emit(db, 'booking.held', { bookingId: bk });
  fakeClock.advance('1m');
  const e2 = await emit(db, 'booking.paid', { bookingId: bk });
  await emit(db, 'booking.held', { bookingId: other });
  assert.deepEqual((await history(db, { bookingId: bk })).map(e => e.id), [e1, e2]);
});
