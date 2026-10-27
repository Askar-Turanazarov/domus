// 12 §4, 13 §9.2, §9.5, 05 §12 (FR-ADM-04, FR-ADM-05): lists with tabs / search / counts / cursor, the booking card, extend and cancel
// with a reason and a stale screen, a developer cancel that returns the deposit by itself, the manual refund for the head only,
// payments with filters and totals, Idempotency-Key — over HTTP with the real staff gate.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { fakeClock } from '../../server/core/clock.js';
import { createHold } from '../../server/core/bookings.js';
import { startPayment } from '../../server/core/payments.js';
import { refundJobHandlers } from '../../server/core/refunds.js';
import { runDue } from '../../server/core/jobs.js';
import { submitCard, confirmCard } from '../../server/payments/card.js';
import { hashPassword } from '../../server/adminAuth.js';
import { createStaff } from '../../server/core/staff.js';
import { mountAdmin } from '../../server/http/admin.js';
import { mountAdminBookings } from '../../server/http/adminBookings.js';
import { requestId, apiErrors } from '../../server/http/common.js';
import { createTestDb, resetDb } from '../support/db.js';
import { makeClient, makeBooking } from '../support/factories.js';

const PASSWORD = 'bookings test password';
const ENV = { LINK_SECRET: 'test-secret', SESSION_SECRET: 'x'.repeat(40), LOG_SALT: 'salt', TELEGRAM_STAFF_CHAT_ID: '-1', PUBLIC_URL: 'https://domus.test' };
const WEB = { type: 'client', id: null, role: 'client', channel: 'web' };
let db, server, base, cookies;

before(async () => {
  db = await createTestDb();
  const app = express();
  app.use(requestId);
  const staffAuth = mountAdmin(app, db, { env: ENV, cacheMs: 0 });
  mountAdminBookings(app, db, staffAuth, { env: ENV });
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
async function call(method, path, { role = 'manager', body, key } = {}) {
  const headers = { 'X-Requested-With': 'domus-admin' };
  if (role) headers.cookie = cookies[role];
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method === 'POST' && key !== null) headers['Idempotency-Key'] = key ?? `key-${++n}-${Math.random().toString(36).slice(2, 10)}`;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// A booking paid with the HUMO emulator, as in the refund tests. → { booking, paymentId }.
async function booked(apartmentNo = 41, phone = '+998901234567') {
  const { booking } = await createHold(db, { apartmentNo, client: { name: 'Дилноза Р.', phone }, consent: { version: '2026-10-27' }, channel: 'web' }, WEB, { env: ENV });
  const { paymentId } = await startPayment(db, { target: { bookingId: booking.id }, provider: 'card' }, WEB, { env: ENV });
  const { sms } = await submitCard(db, { paymentId, number: '9860 0000 0009 0001', expiry: '12/29' }, { env: ENV });
  assert.equal((await confirmCard(db, { paymentId, code: sms.code }, { env: ENV })).status, 'succeeded');
  return { booking: await db.one('SELECT * FROM bookings WHERE id = $1', [booking.id]), paymentId };
}
const runRefunds = () => runDue(db, refundJobHandlers({ env: ENV }).handlers, { limit: 20 });

test('without a session every entry answers 401; the refund entries are for the head only', async () => {
  for (const p of ['/api/admin/bookings', '/api/admin/bookings/1', '/api/admin/bookings/1/link', '/api/admin/payments', '/api/admin/payments/x']) {
    assert.equal((await call('GET', p, { role: null })).status, 401, p);
  }
  for (const p of ['/api/admin/bookings/1/extend', '/api/admin/bookings/1/cancel', '/api/admin/payments/x/refund', '/api/admin/refunds/x/retry']) {
    assert.equal((await call('POST', p, { role: null, body: {} })).status, 401, p);
  }
  const { paymentId } = await booked();
  assert.equal((await call('POST', `/api/admin/payments/${paymentId}/refund`, { role: 'manager', body: { reason: 'по просьбе' } })).status, 403);
  assert.equal((await call('POST', `/api/admin/refunds/${paymentId}/retry`, { role: 'manager', body: {} })).status, 403);
});

test('the list: tabs by the real deadline, counts, search by number / apartment / phone / name, masks', async () => {
  const c = await makeClient(db, { name: 'Дилноза', phone: '+998901234567', tg: 5 });
  const d = await makeClient(db, { name: 'Бобур', phone: '+998935550011' });
  const held = await makeBooking(db, { apartmentNo: 41, clientId: c.id, status: 'held', minutes: 10 });
  const soon = await makeBooking(db, { apartmentNo: 42, clientId: c.id, status: 'booked', minutes: 120 });
  const far = await makeBooking(db, { apartmentNo: 43, clientId: d.id, status: 'booked', minutes: 3 * 24 * 60 });
  const lapsed = await makeBooking(db, { apartmentNo: 44, clientId: d.id, status: 'booked', minutes: -5 });     // past the deadline, not swept yet
  const stale = await makeBooking(db, { apartmentNo: 45, clientId: d.id, status: 'held', minutes: -1 });        // same for a hold

  const tab = async (t, extra = '') => (await call('GET', `/api/admin/bookings?tab=${t}${extra}`)).body;
  const nos = r => r.items.map(i => i.no).sort((a, b) => a - b);
  const sorted = (...b) => b.map(x => x.no).sort((x, y) => x - y);

  const active = await tab('active');
  assert.deepEqual(nos(active), sorted(soon, far));
  assert.deepEqual(nos(await tab('held')), sorted(held));
  assert.deepEqual(nos(await tab('soon')), sorted(soon));
  assert.deepEqual(nos(await tab('closed')), sorted(lapsed, stale));
  assert.deepEqual(active.counts, { active: 2, held: 1, soon: 1 });
  assert.equal(active.next, null);
  assert.match(active.at, /\+05:00$/);

  const row = active.items.find(i => i.no === soon.no);
  assert.equal(row.status, 'booked');
  assert.equal(row.soon, true);
  assert.equal(row.apartment.no, 42);
  assert.equal(row.client.name, 'Дилноза');
  assert.equal(row.client.telegramLinked, true);
  assert.match(row.client.phone, /\*/);
  assert.equal(row.deposit, 10000000);
  assert.equal(active.items.find(i => i.no === far.no).soon, false);
  assert.equal((await tab('closed')).items.find(i => i.no === lapsed.no).status, 'expired');
  assert.ok(!JSON.stringify(active).includes('998901234567'));

  assert.deepEqual(nos(await tab('active', `&q=${soon.no}`)), sorted(soon));       // by the booking number
  assert.deepEqual(nos(await tab('active', '&q=43')), sorted(far));                // by the apartment
  assert.deepEqual(nos(await tab('active', '&q=90123')), sorted(soon));            // by a part of the phone
  assert.deepEqual(nos(await tab('active', `&q=${encodeURIComponent('+998 93 555')}`)), sorted(far));
  assert.deepEqual(nos(await tab('active', `&q=${encodeURIComponent('бобу')}`)), sorted(far));   // by the name, any case
  assert.deepEqual(nos(await tab('active', '&q=%25')), []);                        // a wildcard is a letter, not a pattern
  assert.equal((await call('GET', '/api/admin/bookings?tab=nope')).status, 400);
});

test('the list pages by a cursor, newest first, without gaps or repeats', async () => {
  const c = await makeClient(db, { name: 'Аня', phone: '+998901112233' });
  const made = [];
  for (let i = 0; i < 5; i++) {
    fakeClock.set(`2026-10-28T10:0${i}:00+05:00`);
    made.push(await makeBooking(db, { apartmentNo: 50 + i, clientId: c.id, status: 'booked', minutes: 3 * 24 * 60 }));
  }
  fakeClock.set('2026-10-28T11:00:00+05:00');
  const seen = [];
  let cursor = '';
  for (let page = 0; page < 5; page++) {
    const r = (await call('GET', `/api/admin/bookings?tab=active&limit=2${cursor}`)).body;
    seen.push(...r.items.map(i => i.no));
    if (!r.next) break;
    cursor = `&cursor=${r.next}`;
  }
  assert.deepEqual(seen, made.map(b => b.no).reverse());
  assert.equal((await call('GET', '/api/admin/bookings?cursor=garbage')).status, 400);
});

test('the card: the booking, its payments with the card mask only, its events; the personal link; 404', async () => {
  const { booking, paymentId } = await booked();
  const card = (await call('GET', `/api/admin/bookings/${booking.no}`)).body;
  assert.equal(card.booking.no, booking.no);
  assert.equal(card.booking.status, 'booked');
  assert.equal(card.booking.canExtend, true);
  assert.equal(card.booking.canCancel, true);
  assert.equal(card.booking.version, booking.version);
  assert.equal(card.booking.client.name, 'Дилноза Р.');
  assert.equal(card.apartment.no, 41);
  assert.ok(card.limits.extendMaxHours > 0);
  assert.equal(card.payments.length, 1);
  assert.equal(card.payments[0].id, paymentId);
  assert.equal(card.payments[0].status, 'succeeded');
  assert.equal(card.payments[0].cardBrand, 'HUMO');
  assert.match(card.payments[0].cardMask, /•/);
  assert.ok(!JSON.stringify(card).includes('9860 0000 0009 0001') && !JSON.stringify(card).includes('998901234567'));
  assert.ok(card.history.map(e => e.type).includes('booking.paid'));
  assert.equal(card.history[0].at >= card.history[card.history.length - 1].at, true, 'newest first');

  const { link } = (await call('GET', `/api/admin/bookings/${booking.no}/link`)).body;
  assert.match(link, new RegExp(`^/b/${booking.no}-[A-Za-z0-9_-]{32}$`));
  const before = (await db.one('SELECT count(*)::int AS n FROM events')).n;
  await call('GET', `/api/admin/bookings/${booking.no}/link`);
  assert.equal((await db.one('SELECT count(*)::int AS n FROM events')).n, before, 'reading the link writes nothing');

  for (const p of ['/api/admin/bookings/99999', '/api/admin/bookings/abc', '/api/admin/bookings/0', '/api/admin/bookings/99999/link']) {
    const r = await call('GET', p);
    assert.equal(r.status, 404, p);
    assert.equal(r.body.error, 'booking_not_found');
  }
});

test('extend: a reason, the limit, a stale screen, Idempotency-Key', async () => {
  const { booking } = await booked();
  const path = `/api/admin/bookings/${booking.no}/extend`;
  const body = { hours: 24, reason: 'клиент в поездке', expectedVersion: booking.version };

  assert.equal((await call('POST', path, { body, key: null })).status, 400);                                     // no key
  assert.equal((await call('POST', path, { body: { ...body, reason: '' } })).status, 422);                       // no reason
  assert.equal((await call('POST', path, { body: { ...body, hours: 1000 } })).status, 422);                      // beyond extend_max_hours
  assert.equal((await call('POST', path, { body: { ...body, note: 'x' } })).status, 400);                        // unknown field
  assert.equal((await call('POST', path, { body: { hours: 24, reason: 'клиент в поездке' } })).status, 400);     // no expectedVersion

  const first = await call('POST', path, { body, key: 'extend-key-0001' });
  assert.equal(first.status, 200);
  const was = booking.expires_at.getTime();
  assert.equal(new Date(first.body.booking.expiresAt).getTime(), was + 24 * 3600e3);
  assert.equal(first.body.booking.version, booking.version + 1);

  const replay = await call('POST', path, { body, key: 'extend-key-0001' });                                    // the same intention again
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, first.body);
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM events WHERE type = 'booking.extended'`)).n, 1);
  assert.equal((await call('POST', path, { body: { ...body, hours: 48 }, key: 'extend-key-0001' })).body.error, 'idempotency_conflict');

  const old = await call('POST', path, { body });                                                                // the screen did not see the change
  assert.equal(old.status, 409);
  assert.equal(old.body.error, 'stale');
  assert.equal(old.body.vars.current.version, booking.version + 1);
  assert.equal(old.body.vars.current.no, booking.no);
});

test('cancel by the developer: a reason, the deposit comes back by itself; the job ends it as refunded', async () => {
  const { booking, paymentId } = await booked();
  const path = `/api/admin/bookings/${booking.no}/cancel`;
  assert.equal((await call('POST', path, { body: { initiator: 'developer', expectedVersion: booking.version } })).status, 422);   // no reason
  assert.equal((await call('POST', path, { body: { initiator: 'boss', reason: 'тест', expectedVersion: booking.version } })).status, 400);

  const r = await call('POST', path, { body: { initiator: 'developer', reason: 'ошибка в цене', expectedVersion: booking.version } });
  assert.equal(r.status, 200);
  assert.equal(r.body.booking.status, 'cancelled');
  assert.equal(r.body.booking.cancelInitiator, 'developer');
  assert.equal(r.body.booking.canCancel, false);
  assert.equal(r.body.refund.status, 'pending');
  assert.equal(r.body.refund.reason, 'developer_cancel');
  assert.equal((await db.one('SELECT status FROM payments WHERE id = $1', [paymentId])).status, 'refund_due');

  await runRefunds();
  const card = (await call('GET', `/api/admin/payments/${paymentId}`)).body;
  assert.equal(card.payment.status, 'refunded');
  assert.equal(card.refunds[0].status, 'succeeded');
  assert.equal(card.canRefund, false);
});

test('cancel by the client keeps the deposit; only the head can give it back, with a reason, once', async () => {
  const { booking, paymentId } = await booked();
  const r = await call('POST', `/api/admin/bookings/${booking.no}/cancel`, { body: { initiator: 'client', reason: 'передумал', expectedVersion: booking.version } });
  assert.equal(r.status, 200);
  assert.equal(r.body.refund, undefined);
  assert.equal((await db.one('SELECT status FROM payments WHERE id = $1', [paymentId])).status, 'succeeded');

  const card = (await call('GET', `/api/admin/payments/${paymentId}`, { role: 'head' })).body;
  assert.equal(card.canRefund, true);

  const refundPath = `/api/admin/payments/${paymentId}/refund`;
  assert.equal((await call('POST', refundPath, { role: 'manager', body: { reason: 'по просьбе' } })).status, 403);
  assert.equal((await call('POST', refundPath, { role: 'head', body: {} })).status, 422);                          // the reason is required
  assert.equal((await call('POST', refundPath, { role: 'head', body: { reason: 'по просьбе', amount: 5 } })).status, 400);   // no partial refunds
  assert.equal((await call('POST', refundPath, { role: 'head', body: { reason: 'по просьбе' }, key: null })).status, 400);

  const ok = await call('POST', refundPath, { role: 'head', body: { reason: 'решение руководителя' }, key: 'refund-key-0001' });
  assert.equal(ok.status, 201);
  assert.match(ok.body.refundId, /^[0-9a-f-]{36}$/);
  const again = await call('POST', refundPath, { role: 'head', body: { reason: 'решение руководителя' }, key: 'refund-key-0001' });
  assert.deepEqual(again.body, ok.body, 'the repeat of the same click');
  assert.equal((await db.query('SELECT id FROM refunds WHERE payment_id = $1', [paymentId])).length, 1);
  assert.equal((await call('POST', refundPath, { role: 'head', body: { reason: 'ещё раз' } })).status, 409, 'a second intention');

  await runRefunds();
  assert.equal((await db.one('SELECT status FROM payments WHERE id = $1', [paymentId])).status, 'refunded');
  assert.equal((await call('POST', `/api/admin/refunds/${ok.body.refundId}/retry`, { role: 'head', body: {} })).status, 409);   // nothing failed
});

test('a manual refund of a live booking is refused; a failed refund can be repeated by the head', async () => {
  const { booking, paymentId } = await booked();
  const r = await call('POST', `/api/admin/payments/${paymentId}/refund`, { role: 'head', body: { reason: 'просто так' } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'refund_not_allowed');
  assert.equal((await call('GET', `/api/admin/payments/${paymentId}`)).body.canRefund, false);

  await call('POST', `/api/admin/bookings/${booking.no}/cancel`, { body: { initiator: 'developer', reason: 'ошибка', expectedVersion: booking.version } });
  await db.query(`UPDATE refunds SET status = 'failed', failure = 'manual_required' WHERE payment_id = $1`, [paymentId]);
  await db.query(`DELETE FROM jobs WHERE type = 'refund.process'`);
  const card = (await call('GET', `/api/admin/payments/${paymentId}`, { role: 'head' })).body;
  assert.equal(card.retryRefundId, card.refunds[0].id);
  const retry = await call('POST', `/api/admin/refunds/${card.retryRefundId}/retry`, { role: 'head', body: {} });
  assert.equal(retry.status, 201);
  assert.notEqual(retry.body.refundId, card.retryRefundId);
  assert.equal((await call('POST', '/api/admin/refunds/not-a-uuid/retry', { role: 'head', body: {} })).status, 409);
});

test('payments: filters, totals over the whole filter, cursor, the card without card numbers', async () => {
  const a = await booked(41, '+998901234567');
  const b = await booked(42, '+998935550011');
  await db.query(`UPDATE payments SET provider = 'click' WHERE id = $1`, [b.paymentId]);
  fakeClock.set('2026-10-28T20:00:00+05:00');   // inside the 12 h of the session
  const c = await booked(43, '+998977771122');
  await db.query(`UPDATE payments SET status = 'failed', failure_reason = 'bank_declined', succeeded_at = NULL WHERE id = $1`, [c.paymentId]);

  const all = (await call('GET', '/api/admin/payments')).body;
  assert.equal(all.items.length, 3);
  assert.deepEqual(all.totals, { count: 3, succeededCount: 2, succeededAmount: 20000000 });
  assert.equal(all.items[0].id, c.paymentId, 'newest first');
  assert.equal(all.items[0].failureReason, 'bank_declined');
  assert.equal(all.items[0].bookingNo, c.booking.no);
  assert.match(all.items[0].client.phone, /\*/);

  const click = (await call('GET', '/api/admin/payments?provider=click')).body;
  assert.deepEqual(click.items.map(p => p.id), [b.paymentId]);
  assert.deepEqual(click.totals, { count: 1, succeededCount: 1, succeededAmount: 10000000 });
  assert.deepEqual((await call('GET', '/api/admin/payments?status=failed')).body.items.map(p => p.id), [c.paymentId]);
  assert.deepEqual((await call('GET', '/api/admin/payments?from=2026-10-28T15:00:00%2B05:00')).body.items.map(p => p.id), [c.paymentId]);
  assert.equal((await call('GET', '/api/admin/payments?from=2026-10-28&to=2026-10-28')).body.items.length, 3);   // `to` includes its day
  assert.equal((await call('GET', '/api/admin/payments?to=2026-10-27')).body.items.length, 0);
  assert.equal((await call('GET', '/api/admin/payments?provider=paypal')).status, 400);
  assert.equal((await call('GET', '/api/admin/payments?status=weird')).status, 400);
  assert.equal((await call('GET', '/api/admin/payments?from=yesterday')).status, 400);

  const p1 = (await call('GET', '/api/admin/payments?limit=2')).body;
  assert.equal(p1.items.length, 2);
  assert.equal(p1.totals.count, 3, 'totals do not shrink to the page');
  const p2 = (await call('GET', `/api/admin/payments?limit=2&cursor=${p1.next}`)).body;
  assert.deepEqual([...p1.items, ...p2.items].map(p => p.id), all.items.map(p => p.id));
  assert.equal(p2.next, null);

  const card = (await call('GET', `/api/admin/payments/${a.paymentId}`)).body;
  assert.equal(card.payment.code.startsWith('P-'), true);
  assert.equal(card.payment.cardBrand, 'HUMO');
  assert.ok(!JSON.stringify(card).includes('9860 0000 0009 0001'));
  assert.deepEqual(card.refunds, []);
  assert.deepEqual(card.attempts, []);
  for (const p of ['/api/admin/payments/abc', '/api/admin/payments/00000000-0000-4000-8000-000000000000']) {
    const r = await call('GET', p);
    assert.equal(r.status, 404, p);
    assert.equal(r.body.error, 'payment_not_found');
  }
});
