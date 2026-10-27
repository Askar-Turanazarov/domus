// 03 §12: viewings in the base — the Domus checks plus working hours and 60 days; notifications and the reminder job.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock } from '../../server/core/clock.js';
import { viewingTime, previewViewing, scheduleViewing, viewingJobHandlers } from '../../server/core/viewingsDb.js';
import { markSold } from '../../server/core/apartments.js';
import { createTestDb, resetDb } from '../support/db.js';
import { makeClient, makeStaff, asClient, asStaff } from '../support/factories.js';

let db;
const ENV = { TELEGRAM_STAFF_CHAT_ID: '-1', LINK_SECRET: 'test-secret' };
before(async () => { db = await createTestDb(); });
after(() => db.close());
beforeEach(async () => { await resetDb(db); fakeClock.set('2026-10-28T10:00:00+05:00'); });
afterEach(() => fakeClock.reset());

test('viewingTime: Tashkent by default, an offset is kept, anything else → null', () => {
  assert.equal(viewingTime('2026-10-30T15:00').toISOString(), '2026-10-30T10:00:00.000Z');
  assert.equal(viewingTime('2026-10-30T15:00Z').toISOString(), '2026-10-30T15:00:00.000Z');
  for (const bad of ['2026-10-30 15:00', '30.10.2026 15:00', '', null, '2026-13-40T15:00']) assert.equal(viewingTime(bad), null, String(bad));
});

test('03 §12: the checks in order', async () => {
  const p = (apartmentNo, datetime) => previewViewing(db, { apartmentNo, datetime }, { env: ENV });
  await assert.rejects(p(999, '2026-10-30T15:00'), { code: 'apartment_not_found' });
  await assert.rejects(p(41, 'tomorrow'), { code: 'datetime_invalid' });
  await assert.rejects(p(41, '2026-10-28T09:30'), { code: 'datetime_past' });
  await assert.rejects(p(41, '2027-01-10T15:00'), { code: 'datetime_too_far' });
  await assert.rejects(p(41, '2026-10-30T08:59'), { code: 'outside_hours' });
  await assert.rejects(p(41, '2026-10-30T20:00'), { code: 'outside_hours' });
  assert.equal((await p(41, '2026-10-30T19:59')).local, '2026-10-30 19:59');
  const head = await makeStaff(db, { login: 'h', role: 'head' });
  await markSold(db, { apartmentNo: 42, expectedVersion: 1 }, asStaff(head), { env: ENV });
  await assert.rejects(p(42, '2026-10-30T15:00'), { code: 'apartment_sold' });
});

test('03 §12: a viewing — event, viewing_confirmed, staff_viewing_created with the mask, the reminder 3 h before; the slot is taken', async () => {
  const c = await makeClient(db, { phone: '+998901234567' });
  const v = await scheduleViewing(db, { apartmentNo: 41, datetime: '2026-10-30T15:00', clientId: c.id, channel: 'web' }, asClient(c), { env: ENV });
  assert.equal(v.status, 'scheduled');
  assert.equal(v.name, 'Аня');
  assert.equal((await db.query(`SELECT 1 FROM events WHERE type = 'viewing.created'`)).length, 1);
  const out = await db.query('SELECT template, vars FROM outbox ORDER BY id');
  assert.deepEqual(out.map(o => o.template), ['viewing_confirmed', 'staff_viewing_created']);
  assert.equal(out[1].vars.phoneMasked, '+998 90 *** ** 67');
  const job = await db.one(`SELECT run_at, payload FROM jobs WHERE type = 'viewing.remind'`);
  assert.equal(job.run_at.toISOString(), '2026-10-30T07:00:00.000Z');
  await assert.rejects(scheduleViewing(db, { apartmentNo: 41, datetime: '2026-10-30T15:00', clientId: c.id, channel: 'web' }, asClient(c), { env: ENV }),
    { code: 'slot_taken' });
  const { handlers } = viewingJobHandlers({ env: ENV });
  assert.equal(await db.tx(q => handlers['viewing.remind']({ payload: job.payload }, { q, now: () => new Date('2026-10-30T07:00:00Z') })), 'done');
  await db.query(`UPDATE viewings SET status = 'cancelled' WHERE id = $1`, [v.id]);
  assert.equal(await db.tx(q => handlers['viewing.remind']({ payload: job.payload }, { q, now: () => new Date('2026-10-30T07:00:00Z') })), 'skipped');
});

test('03 §12: no phone on the card → need_phone; a bad given phone → phone_invalid; a near viewing gets no reminder', async () => {
  const c = await makeClient(db);
  const at = (datetime, phone) => scheduleViewing(db, { apartmentNo: 41, datetime, clientId: c.id, phone, channel: 'web' }, asClient(c), { env: ENV });
  await assert.rejects(at('2026-10-30T15:00'), { code: 'need_phone' });
  await assert.rejects(at('2026-10-30T15:00', '12'), { code: 'phone_invalid' });
  await at('2026-10-28T12:00', '+998901234567');
  assert.equal((await db.query(`SELECT 1 FROM jobs WHERE type = 'viewing.remind'`)).length, 0);
});
