// Click SHOP API (05 §5, §14): the control signatures, the order of checks, repeats (DoD-4), −5017, Complete after
// the hold, the emulator calling our routes with real HTTP.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { fakeClock } from '../../server/core/clock.js';
import { createHold } from '../../server/core/bookings.js';
import { startPayment } from '../../server/core/payments.js';
import { mountPayments } from '../../server/http/payments.js';
import { clickSign, clickRequest, clickProvider } from '../../server/payments/click.js';
import { createTestDb, resetDb } from '../support/db.js';

let db, server, base;
const ENV = { LINK_SECRET: 'test-secret' };
const WEB = { type: 'client', id: null, role: 'client', channel: 'web' };
const SECRET = 'mock-click-secret-key';

before(async () => {
  db = await createTestDb();
  const app = express();
  app.use(express.json());
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  ENV.PUBLIC_URL = base;                                     // the emulator calls this very server over HTTP
  mountPayments(app, db, { env: ENV });
});
after(async () => { server.close(); await db.close(); });
beforeEach(async () => {
  await resetDb(db);
  fakeClock.set('2026-10-28T10:00:00+05:00');
});
afterEach(() => fakeClock.reset());

async function pay(apartmentNo = 41) {
  const { booking } = await createHold(db, { apartmentNo, client: { name: 'Аня', phone: `+9989012345${apartmentNo}` },
    consent: { version: '2026-10-27' }, channel: 'web' }, WEB, { env: ENV });
  const r = await startPayment(db, { target: { bookingId: booking.id }, provider: 'click' }, WEB, { env: ENV });
  return { booking, payment: await db.one('SELECT * FROM payments WHERE id = $1', [r.paymentId]), url: r.url };
}
const form = async (path, fields) => {
  const r = await fetch(`${base}/api/payments/click/${path}`, { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
  assert.equal(r.status, 200, 'Click always gets 200');
  return r.json();
};
const ids = { clickTransId: 2950123, paydocId: 3810456 };
const prepare = (p, extra = {}) => form('prepare', { ...clickRequest(p, 0, { ...ids, at: new Date() }, ENV), ...extra });
const complete = (p, prepareId, extra = {}, error = 0) =>
  form('complete', { ...clickRequest(p, 1, { ...ids, prepareId, error, at: new Date() }, ENV), ...extra });
const statusOf = async id => db.one('SELECT status, failure_reason FROM payments WHERE id = $1', [id]);

test('signature: the control values of 05 §5.4', () => {
  const f = { click_trans_id: '2950123', service_id: '10000', merchant_trans_id: 'P-7F3A', amount: '10000000.00' };
  assert.equal(clickSign({ ...f, action: '0', sign_time: '2026-10-29 14:05:12' }, SECRET), '6c28b06fff3f4fa5c2f228dd65544cae');
  assert.equal(clickSign({ ...f, action: '1', merchant_prepare_id: '17', sign_time: '2026-10-29 14:05:20' }, SECRET),
    '6335ebbe7257921b181111bc768c7f3d');
});

test('Prepare → Complete → booking; repeated Prepare → the same merchant_prepare_id, repeated Complete → −4 (DoD-4)', async () => {
  const { booking, payment } = await pay();
  const p1 = await prepare(payment);
  assert.deepEqual([p1.error, p1.error_note, p1.merchant_trans_id], [0, 'Success', payment.code]);
  assert.equal((await statusOf(payment.id)).status, 'processing');
  assert.equal((await prepare(payment)).merchant_prepare_id, p1.merchant_prepare_id);
  const c1 = await complete(payment, p1.merchant_prepare_id);
  assert.deepEqual([c1.error, c1.merchant_confirm_id], [0, p1.merchant_prepare_id]);
  assert.equal((await db.one('SELECT status FROM bookings WHERE id = $1', [booking.id])).status, 'booked');
  const before = await db.one('SELECT * FROM payments WHERE id = $1', [payment.id]);
  assert.equal(before.provider_ref, '2950123');
  assert.equal((await complete(payment, p1.merchant_prepare_id)).error, -4);
  const after = await db.one('SELECT * FROM payments WHERE id = $1', [payment.id]);
  assert.deepEqual([after.status, after.amount, after.version], [before.status, before.amount, before.version]);
  const log = await db.query(`SELECT event_id, result FROM provider_events WHERE provider = 'click' ORDER BY received_at, event_id`);
  assert.deepEqual(log.map(r => r.event_id).sort(), ['2950123:0', '2950123:1']);
});

test('the order of checks: −8 fields, −3 action, −1 signature, −5 payment, −2 amount, −6 transaction', async () => {
  const { payment } = await pay();
  assert.equal((await form('prepare', { click_trans_id: '1' })).error, -8);
  assert.equal((await form('complete', clickRequest(payment, 0, { ...ids, at: new Date() }, ENV))).error, -3);
  assert.equal((await prepare(payment, { sign_string: '0'.repeat(32) })).error, -1);
  assert.equal((await prepare(payment, { service_id: '99999' })).error, -1);
  const ghost = { ...payment, code: 'P-XXXX' };
  assert.equal((await prepare(ghost)).error, -5);
  assert.equal((await prepare({ ...payment, amount: Number(payment.amount) + 1 })).error, -2);
  assert.equal((await complete(payment, 17)).error, -6, 'Complete without Prepare');
  const p = await prepare(payment);
  assert.equal((await complete(payment, p.merchant_prepare_id + 1)).error, -6);
  assert.equal((await statusOf(payment.id)).status, 'processing');
});

test('Complete with error −5017 → failed / insufficient_funds, answer −9; other negative → bank_declined', async () => {
  const a = await pay(41);
  const pa = await prepare(a.payment);
  assert.equal((await complete(a.payment, pa.merchant_prepare_id, {}, -5017)).error, -9);
  assert.deepEqual(await statusOf(a.payment.id), { status: 'failed', failure_reason: 'insufficient_funds' });
  const b = await pay(42);
  const pb = await form('prepare', clickRequest(b.payment, 0, { clickTransId: 77, paydocId: 1, at: new Date() }, ENV));
  await form('complete', clickRequest(b.payment, 1, { clickTransId: 77, paydocId: 1, prepareId: pb.merchant_prepare_id, error: -5000, at: new Date() }, ENV));
  assert.deepEqual(await statusOf(b.payment.id), { status: 'failed', failure_reason: 'bank_declined' });
});

test('Complete after the hold ended → −9, failed / hold_expired, no booking; a cancelled payment → −9', async () => {
  const { booking, payment } = await pay(41);
  const p = await prepare(payment);
  fakeClock.advance('16m');
  assert.equal((await complete(payment, p.merchant_prepare_id)).error, -9);
  assert.deepEqual(await statusOf(payment.id), { status: 'failed', failure_reason: 'hold_expired' });
  assert.notEqual((await db.one('SELECT status FROM bookings WHERE id = $1', [booking.id])).status, 'booked');

  fakeClock.set('2026-10-28T11:00:00+05:00');
  const second = await pay(42);
  const p2 = await form('prepare', clickRequest(second.payment, 0, { clickTransId: 88, paydocId: 1, at: new Date() }, ENV));
  await startPayment(db, { target: { bookingId: second.booking.id }, provider: 'card' }, WEB, { env: ENV });   // replaced
  const c2 = await form('complete', clickRequest(second.payment, 1, { clickTransId: 88, paydocId: 1, prepareId: p2.merchant_prepare_id, at: new Date() }, ENV));
  assert.equal(c2.error, -9);
});

test('the emulator: card → code → real HTTP Prepare/Complete → booking; the declined card → its reason', async () => {
  const { booking, payment, url } = await pay(41);
  assert.equal(url, `${base}/pay/click/${payment.id}`);
  const post = (path, body) => fetch(`${base}/api/payments/${payment.id}/click/${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
  const sms = await post('card', { number: '8600 0000 0006 0001', expiry: '12/29' });
  assert.equal(sms.status, 200);
  assert.equal((await statusOf(payment.id)).status, 'pending', 'the merchant knows nothing before Prepare');
  const done = await post('confirm', { code: sms.body.sms.code });
  assert.equal(done.body.status, 'succeeded');
  assert.match(done.body.redirect, /\?paid=1$/);
  assert.equal((await db.one('SELECT status FROM bookings WHERE id = $1', [booking.id])).status, 'booked');
  assert.equal((await db.query(`SELECT 1 FROM provider_events WHERE payment_id = $1`, [payment.id])).length, 2);

  const other = await pay(42);
  const p2 = (path, body) => fetch(`${base}/api/payments/${other.payment.id}/click/${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  const s2 = await p2('card', { number: '9860 0000 0008 0002', expiry: '12/29' });
  const r2 = await p2('confirm', { code: s2.sms.code, lang: 'en' });
  assert.deepEqual([r2.status, r2.failureReason, r2.failureText], ['failed', 'insufficient_funds', 'Insufficient funds on the card.']);
});

test('the emulator without a reachable server → failed / provider_error; in process it works without the network', async () => {
  const env = { ...ENV, PUBLIC_URL: 'http://127.0.0.1:9' };
  const { payment } = await pay(41);
  const { submitClickCard, confirmClick } = await import('../../server/payments/click.js');
  const s = await submitClickCard(db, { paymentId: payment.id, number: '9860 0000 0009 0001', expiry: '12/29' }, { env });
  const r = await confirmClick(db, { paymentId: payment.id, code: s.sms.code }, { env });
  assert.deepEqual([r.status, r.failureReason], ['failed', 'provider_error']);

  const second = await pay(42);
  const inproc = { ...ENV, CLICK_EMULATOR_TRANSPORT: 'inprocess' };
  const s2 = await submitClickCard(db, { paymentId: second.payment.id, number: '9860 0000 0009 0001', expiry: '12/29' }, { env: inproc });
  assert.equal((await confirmClick(db, { paymentId: second.payment.id, code: s2.sms.code }, { env: inproc })).status, 'succeeded');
});

test('live mode: the my.click.uz link; without every key the provider is off', async () => {
  const live = clickProvider({ CLICK_MODE: 'live', CLICK_SERVICE_ID: '1', CLICK_MERCHANT_ID: '2', CLICK_MERCHANT_USER_ID: '3', CLICK_SECRET_KEY: 's' });
  assert.equal(live.mode(), 'live');
  const { url } = await live.begin({ id: 'abc', code: 'P-7F3A', amount: 10000000 }, { origin: 'https://d.test' });
  assert.equal(url, 'https://my.click.uz/services/pay?service_id=1&merchant_id=2&amount=10000000.00&transaction_param=P-7F3A&return_url=https%3A%2F%2Fd.test%2Fpay%2Freturn%3Fpayment%3Dabc');
  assert.equal(clickProvider({ CLICK_MODE: 'live' }).enabled(), false);
});
