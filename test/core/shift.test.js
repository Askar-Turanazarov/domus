// Demo time shift (04 §6.1, FR-DEMO-01): the head moves a deadline to «in a minute» so the expiry can be shown live.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock, now } from '../../server/core/clock.js';
import { createHold, confirmPaid, shiftDeadline, getBooking, bookingJobHandlers } from '../../server/core/bookings.js';
import { runDue } from '../../server/core/jobs.js';
import { context } from '../../server/core/tx.js';
import { createTestDb, resetDb } from '../support/db.js';
import { makeStaff, asStaff } from '../support/factories.js';

let db, manager, head;
const ENV = { TELEGRAM_STAFF_CHAT_ID: '-1', LINK_SECRET: 'test-secret' };
const WEB = { type: 'client', id: null, role: 'client', channel: 'web' };
before(async () => { db = await createTestDb(); });
after(() => db.close());
beforeEach(async () => {
  await resetDb(db);
  fakeClock.set('2026-10-28T10:00:00+05:00');
  manager = await makeStaff(db);
  head = await makeStaff(db, { login: 'boss', name: 'Руководитель', role: 'head' });
});
afterEach(() => fakeClock.reset());

let pay = 0;
async function holdTg(apartmentNo = 41, userId = 77) {
  const r = await createHold(db, { apartmentNo, client: { telegram: { userId, chatId: userId } }, channel: 'telegram' }, WEB, { env: ENV });
  return r.booking;
}
async function paid(b) {
  const p = await db.one(`INSERT INTO payments (code, kind, booking_id, client_id, provider, amount, status, created_by, created_at, updated_at)
    VALUES ($1, 'deposit', $2, $3, 'card', $4, 'processing', '{"type":"client"}', $5, $5) RETURNING *`,
  [`P-${++pay}`, b.id, b.client_id, b.deposit_amount, now()]);
  const ctx = context({ env: ENV });
  await db.tx(async q => {
    await confirmPaid(q, { outbox: [], jobs: [] }, ctx, { bookingId: b.id, payment: p });
    await q.query(`UPDATE payments SET status = 'succeeded', succeeded_at = $2 WHERE id = $1`, [p.id, now()]);
  });
  return getBooking(db, b.id);
}
const templates = async () => (await db.query('SELECT template FROM outbox ORDER BY id')).map(o => o.template);
const run = async () => runDue(db, bookingJobHandlers({ env: ENV }).handlers, { limit: 50 });
const shift = (b, target, extra = {}, actor = asStaff(head)) => shiftDeadline(db, { bookingId: b.id, target, ...extra }, actor, { env: ENV });
const scheduled = () => db.query("SELECT type, run_at, payload FROM jobs WHERE status = 'scheduled' ORDER BY run_at");

test('hold_1m: the hold ends in a minute by its own job; the client is told and the apartment is free', async () => {
  const b = await holdTg();
  const r = await shift(b, 'hold_1m');
  assert.equal(r.expires_at.getTime(), now().getTime() + 60e3);
  assert.equal(r.version, b.version + 1);
  fakeClock.advance('30s');
  assert.equal((await run()).done, 0);
  fakeClock.advance('31s');
  assert.equal((await run()).done, 1);
  assert.equal((await getBooking(db, b.id)).status, 'hold_expired');
  assert.ok((await templates()).includes('hold_expired'));
  const ev = await db.one("SELECT data FROM events WHERE type = 'demo.time_shifted'");
  assert.equal(ev.data.target, 'hold_1m');
  assert.equal(new Date(ev.data.to).getTime(), now().getTime() - 1e3);
});

test('booking_1m: no reminders are left, the booking expires after a minute', async () => {
  const b = await paid(await holdTg());
  await shift(b, 'booking_1m');
  assert.deepEqual((await scheduled()).map(j => j.type), ['booking.expire']);
  fakeClock.advance('61s');
  assert.equal((await run()).done, 1);
  assert.equal((await getBooking(db, b.id)).status, 'expired');
});

test('booking_3h1m keeps only the 3 h reminder, 24h1m both', async () => {
  let b = await paid(await holdTg());
  await shift(b, 'booking_3h1m');
  let jobs = await scheduled();
  assert.deepEqual(jobs.map(j => [j.type, j.payload.hoursBefore ?? null]), [['booking.remind', 3], ['booking.expire', null]]);
  assert.equal(jobs[0].run_at.getTime(), now().getTime() + 60e3);

  b = await getBooking(db, b.id);
  await shift(b, 'booking_24h1m');
  jobs = await scheduled();
  assert.deepEqual(jobs.map(j => [j.type, j.payload.hoursBefore ?? null]), [['booking.remind', 24], ['booking.remind', 3], ['booking.expire', null]]);
  assert.equal(jobs[0].run_at.getTime(), now().getTime() + 60e3);
  fakeClock.advance('61s');
  assert.equal((await run()).done, 1);
  assert.ok((await templates()).includes('booking_reminder'));
});

test('wrong status, closed booking, stale version, bad target and rights', async () => {
  const b = await holdTg();
  await assert.rejects(shift(b, 'booking_1m'), e => e.code === 'booking_not_active');
  await assert.rejects(shift(b, 'hold_1m', { expectedVersion: b.version + 5 }), e => e.code === 'stale');
  await assert.rejects(shift(b, 'hold_2m'), e => e.code === 'invalid_input' && e.vars.fields[0] === 'target');
  await assert.rejects(shift(b, 'hold_1m', {}, asStaff(manager)), e => e.code === 'forbidden');
  fakeClock.advance('16m');
  await run();
  await assert.rejects(shift(b, 'hold_1m'), e => e.code === 'booking_closed');
});
