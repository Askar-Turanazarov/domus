// Booking after the hold (03 §5–7, 04 §6.1): confirmPaid (T2), late payment, extend (T6), cancel (T5/T8), expiry jobs (T3/T7), I12.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock, now } from '../../server/core/clock.js';
import { createHold, confirmPaid, extend, cancel, getBooking, sweepDue, bookingJobHandlers } from '../../server/core/bookings.js';
import { statusMap } from '../../server/core/apartments.js';
import { runDue } from '../../server/core/jobs.js';
import { context } from '../../server/core/tx.js';
import { DEFAULT_SETTINGS } from '../../server/core/defaults.js';
import { createTestDb, resetDb } from '../support/db.js';
import { makeStaff, asStaff, asClient } from '../support/factories.js';

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
async function payment(b, status = 'processing') {
  return db.one(`INSERT INTO payments (code, kind, booking_id, client_id, provider, amount, status, created_by, created_at, updated_at)
    VALUES ($1, 'deposit', $2, $3, 'card', $4, $5, '{"type":"client"}', $6, $6) RETURNING *`,
  [`P-${++pay}`, b.id, b.client_id, b.deposit_amount, status, now()]);
}
// What the payment layer does (05 §7.1): confirmPaid, then the payment status.
async function paid(b) {
  const p = await payment(b);
  const ctx = context({ env: ENV });
  return db.tx(async q => {
    const fx = { outbox: [], jobs: [] };
    const r = await confirmPaid(q, fx, ctx, { bookingId: b.id, payment: p });
    await q.query(`UPDATE payments SET status = $2, succeeded_at = $3 WHERE id = $1`, [p.id, r === 'booked' ? 'succeeded' : 'refund_due', now()]);
    return { result: r, payment: p };
  });
}
const templates = async () => (await db.query('SELECT template FROM outbox ORDER BY id')).map(o => o.template);
const run = async () => runDue(db, bookingJobHandlers({ env: ENV }).handlers, { limit: 50 });

test('T2: payment → booked for 72 h; hold.expire cancelled; reminders 24 h and 3 h and booking.expire set; messages', async () => {
  const b = await holdTg();
  const { result } = await paid(b);
  assert.equal(result, 'booked');
  const x = await getBooking(db, b.id);
  assert.equal(x.status, 'booked');
  assert.equal(x.expires_at.getTime(), now().getTime() + DEFAULT_SETTINGS.booking_hours * 3600e3);
  assert.equal((await db.one("SELECT status FROM jobs WHERE type = 'hold.expire'")).status, 'cancelled');
  const jobs = await db.query("SELECT type, payload FROM jobs WHERE status = 'scheduled' ORDER BY run_at");
  assert.deepEqual(jobs.map(j => j.type), ['booking.remind', 'booking.remind', 'booking.expire']);
  assert.deepEqual(jobs.slice(0, 2).map(j => j.payload.hoursBefore), [24, 3]);
  assert.deepEqual(await templates(), ['hold_created', 'booking_confirmed', 'booking_pdf', 'staff_booking_paid']);
  const staff = await db.one("SELECT vars FROM outbox WHERE template = 'staff_booking_paid'");
  assert.equal(staff.vars.provider, 'card');
  assert.equal((await statusMap(db))[41], 'booked');
});

test('late payment (BR-17): the hold is over → the booking is not touched, payment_late; a second payment → duplicate', async () => {
  const b = await holdTg();
  fakeClock.advance('16m');
  const { result } = await paid(b);
  assert.equal(result, 'late');
  assert.equal((await db.one('SELECT status FROM bookings WHERE id = $1', [b.id])).status, 'held', 'not swept, not booked');
  assert.ok((await templates()).includes('payment_late'));

  const c = await holdTg(42, 88);
  assert.equal((await paid(c)).result, 'booked');
  assert.equal((await paid(c)).result, 'duplicate');
  assert.equal((await db.query("SELECT 1 FROM events WHERE type = 'payment.late'")).length, 2);
});

test('T6 extend: manager, reason, version; jobs moved; not past extend_max_hours; stale and closed', async () => {
  const b = await holdTg();
  await paid(b);
  const x = await getBooking(db, b.id);
  await assert.rejects(extend(db, { bookingId: b.id, hours: 24, reason: 'ok' }, asClient({ id: b.client_id })), { code: 'forbidden' });
  await assert.rejects(extend(db, { bookingId: b.id, hours: 24, reason: '' }, asStaff(manager)), { code: 'reason_required' });
  await assert.rejects(extend(db, { bookingId: b.id, hours: 24, reason: 'Просьба клиента', expectedVersion: x.version - 1 }, asStaff(manager)),
    { code: 'stale' });
  await assert.rejects(extend(db, { bookingId: b.id, hours: 200, reason: 'Просьба клиента' }, asStaff(manager)), { code: 'extend_too_long' });
  const r = await extend(db, { bookingId: b.id, hours: 24, reason: 'Просьба клиента', expectedVersion: x.version }, asStaff(manager), { env: ENV });
  assert.equal(r.expires_at.getTime(), x.expires_at.getTime() + 24 * 3600e3);
  assert.equal(r.extended_count, 1);
  const live = await db.query("SELECT payload FROM jobs WHERE status = 'scheduled' AND type = 'booking.expire'");
  assert.deepEqual(live.map(j => j.payload.expectedExpiresAt), [r.expires_at.toISOString()]);
  assert.deepEqual((await templates()).slice(-2), ['booking_extended', 'staff_booking_extended']);
  await assert.rejects(extend(db, { bookingId: b.id, hours: 1, reason: 'Ещё раз', expectedVersion: x.version }, asStaff(manager)), { code: 'stale' });
  const h = await holdTg(42, 88);
  await assert.rejects(extend(db, { bookingId: h.id, hours: 1, reason: 'Удержание' }, asStaff(manager)), { code: 'booking_not_active' });
});

test('T8 cancel by client initiator: the deposit stays; by developer: refund requested at once (BR-12)', async () => {
  const b = await holdTg();
  await paid(b);
  const r = await cancel(db, { bookingId: b.id, initiator: 'client', reason: 'Передумал' }, asStaff(manager), { env: ENV });
  assert.equal(r.status, 'cancelled');
  assert.equal(r.cancel_initiator, 'client');
  assert.equal((await db.query('SELECT 1 FROM refunds')).length, 0);
  assert.equal((await db.one("SELECT data FROM events WHERE type = 'booking.cancelled'")).data.depositFate, 'kept');
  assert.equal((await db.query("SELECT 1 FROM jobs WHERE status = 'scheduled' AND payload->>'bookingId' = $1", [b.id])).length, 0);
  await assert.rejects(cancel(db, { bookingId: b.id, initiator: 'client', reason: 'Ещё раз' }, asStaff(manager)), { code: 'booking_closed' });

  const c = await holdTg(42, 88);
  const { payment: q } = await paid(c);
  await cancel(db, { bookingId: c.id, initiator: 'developer', reason: 'Ошибка в цене' }, asStaff(head), { env: ENV });
  const refund = await db.one('SELECT * FROM refunds');
  assert.equal(refund.payment_id, q.id);
  assert.equal(refund.reason, 'developer_cancel');
  assert.equal((await db.one('SELECT status FROM payments WHERE id = $1', [q.id])).status, 'refund_due');
  assert.equal((await db.query("SELECT 1 FROM jobs WHERE type = 'refund.process'")).length, 1);
  assert.equal((await statusMap(db))[42], 'free');
});

test('T5: a hold is cancelled only as developer; a client cancels only their own booked booking', async () => {
  const h = await holdTg();
  await assert.rejects(cancel(db, { bookingId: h.id, initiator: 'client', reason: 'Передумал' }, asStaff(manager)), { code: 'booking_not_active' });
  await assert.rejects(cancel(db, { bookingId: h.id, reason: 'Передумал' }, asClient({ id: h.client_id })), { code: 'booking_not_active' });
  await cancel(db, { bookingId: h.id, initiator: 'developer', reason: 'Снята с продажи' }, asStaff(manager), { env: ENV });
  assert.ok((await templates()).includes('hold_cancelled'));

  const b = await holdTg(42, 88);
  await paid(b);
  await assert.rejects(cancel(db, { bookingId: b.id, reason: 'Чужая' }, asClient({ id: h.client_id })), { code: 'forbidden' });
  const r = await cancel(db, { bookingId: b.id, initiator: 'developer', reason: 'Отменено клиентом' }, asClient({ id: b.client_id }), { env: ENV });
  assert.equal(r.cancel_initiator, 'client', 'a client is always the client initiator');
});

test('T3 by job: hold.expire at the deadline closes the hold and tells the client; a stale job is skipped', async () => {
  const b = await holdTg();
  fakeClock.advance('15m');
  const r = await run();
  assert.equal(r.done, 1);
  assert.equal((await db.one('SELECT status FROM bookings WHERE id = $1', [b.id])).status, 'hold_expired');
  assert.ok((await templates()).includes('hold_expired'));

  const c = await holdTg(42, 88);
  await paid(c);                                                       // hold.expire cancelled; force-run it anyway
  await db.query(`UPDATE jobs SET status = 'scheduled' WHERE type = 'hold.expire' AND payload->>'bookingId' = $1`, [c.id]);
  fakeClock.advance('15m');
  const r2 = await run();
  assert.equal(r2.skipped, 1);
  assert.equal((await db.one('SELECT status FROM bookings WHERE id = $1', [c.id])).status, 'booked');
});

test('T7 and reminders by jobs; after extend the old expire job runs empty', async () => {
  const b = await holdTg();
  await paid(b);
  fakeClock.advance('48h');                                             // 24 h before the end
  assert.equal((await run()).done, 1);
  assert.deepEqual((await templates()).slice(-2), ['booking_reminder', 'staff_booking_expiring']);
  const x = await getBooking(db, b.id);
  await extend(db, { bookingId: b.id, hours: 2, reason: 'Просьба клиента' }, asStaff(manager), { env: ENV });
  await db.query(`UPDATE jobs SET status = 'scheduled' WHERE type = 'booking.expire' AND payload->>'expectedExpiresAt' = $1`,
    [x.expires_at.toISOString()]);
  fakeClock.advance('24h');                                             // old deadline: the old job is empty
  const r = await run();
  assert.equal(r.skipped, 1);
  assert.equal((await getBooking(db, b.id)).status, 'booked');
  fakeClock.advance('2h');
  await run();
  assert.equal((await db.one('SELECT status FROM bookings WHERE id = $1', [b.id])).status, 'expired');
  assert.deepEqual((await templates()).slice(-2), ['booking_expired', 'staff_booking_expired']);
});

test('I12: past the deadline before any job → no read shows it active; the tick sweep closes it', async () => {
  const b = await holdTg();
  await paid(b);
  fakeClock.advance('73h');
  assert.equal((await getBooking(db, b.id)).status, 'expired');
  assert.equal((await statusMap(db))[41], 'free');
  const swept = await sweepDue(db, {}, { env: ENV });
  assert.equal(swept.length, 1);
  assert.equal((await db.one('SELECT status FROM bookings WHERE id = $1', [b.id])).status, 'expired');
});

test('races: extend and cancel of one booking — one passes, the other is stale or closed', async () => {
  const b = await holdTg();
  await paid(b);
  const v = (await getBooking(db, b.id)).version;
  const rs = await Promise.allSettled([
    extend(db, { bookingId: b.id, hours: 2, reason: 'Просьба', expectedVersion: v }, asStaff(manager), { env: ENV }),
    cancel(db, { bookingId: b.id, initiator: 'client', reason: 'Отказ', expectedVersion: v }, asStaff(head), { env: ENV })
  ]);
  assert.equal(rs.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(['stale', 'booking_closed'].includes(rs.find(r => r.status === 'rejected').reason.code));
});
