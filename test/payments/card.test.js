// The UzCard / HUMO emulator over HTTP (05 §4, §14): test cards only, the SMS code, 3 attempts, expiry, hold over
// mid-payment, P6 (no card number anywhere).
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { fakeClock } from '../../server/core/clock.js';
import { createHold } from '../../server/core/bookings.js';
import { startPayment } from '../../server/core/payments.js';
import { mountPayments } from '../../server/http/payments.js';
import { TEST_CARDS, luhn, checkCard } from '../../server/payments/testCards.js';
import { createTestDb, resetDb } from '../support/db.js';

let db, server, base;
const ENV = { LINK_SECRET: 'test-secret', PUBLIC_URL: 'https://domus.test' };
const WEB = { type: 'client', id: null, role: 'client', channel: 'web' };
const HUMO_OK = '9860 0000 0009 0001';

before(async () => {
  db = await createTestDb();
  const app = express();
  app.use(express.json());
  mountPayments(app, db, { env: ENV });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
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
  const { paymentId } = await startPayment(db, { target: { bookingId: booking.id }, provider: 'card' }, WEB, { env: ENV });
  return { booking, paymentId };
}
const post = async (url, body) => {
  const r = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const card = (id, number = HUMO_OK, expiry = '12/29') => post(`/api/payments/${id}/card`, { number, expiry });
const confirm = (id, code, lang = 'ru') => post(`/api/payments/${id}/card/confirm`, { code, lang });
const payment = id => db.one('SELECT * FROM payments WHERE id = $1', [id]);
const bookingStatus = async id => (await db.one('SELECT status FROM bookings WHERE id = $1', [id])).status;

test('the test cards pass Luhn; the form checks: invalid, expired, not a test card', () => {
  assert.ok(TEST_CARDS.every(c => luhn(c.number)));
  const at = new Date('2026-10-28T10:00:00+05:00');
  assert.equal(checkCard({ number: '9860 0000 0009 0002', expiry: '12/29' }, at).error, 'card_invalid');
  assert.equal(checkCard({ number: HUMO_OK, expiry: '09/26' }, at).error, 'card_expired');
  assert.equal(checkCard({ number: HUMO_OK, expiry: '13/29' }, at).error, 'card_expired');
  assert.ok(checkCard({ number: HUMO_OK, expiry: '10/26' }, at).card, 'this month is still valid');
  assert.equal(checkCard({ number: '4242 4242 4242 4242', expiry: '12/29' }, at).error, 'card_not_supported', 'a real Luhn-valid card');
  assert.deepEqual(checkCard({ number: '8600-0000-0005-0002', expiry: '01/27' }, at).card,
    { brand: 'UZCARD', mask: '8600 •••• 0002', scenario: 'insufficient_funds' });
});

test('HUMO success: card → SMS code → booking; a repeat of the button gives the same answer', async () => {
  const { booking, paymentId } = await pay();
  const s = await card(paymentId);
  assert.equal(s.status, 200);
  assert.match(s.body.sms.code, /^\d{6}$/);
  assert.ok(s.body.sms.text.includes(s.body.sms.code));
  assert.deepEqual([s.body.brand, s.body.mask], ['HUMO', '9860 •••• 0001']);
  assert.equal(s.body.codeExpiresAt, new Date(Date.parse('2026-10-28T10:05:00+05:00')).toISOString());
  assert.equal((await payment(paymentId)).status, 'processing');
  const ok = await confirm(paymentId, s.body.sms.code);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'succeeded');
  assert.match(ok.body.redirect, /^\/b\/\d+-[\w-]{32}\?paid=1$/);
  assert.equal(await bookingStatus(booking.id), 'booked');
  const p = await payment(paymentId);
  assert.match(p.provider_ref, /^card_[0-9a-f]{12}$/);
  assert.deepEqual([p.card_brand, p.card_mask], ['HUMO', '9860 •••• 0001']);
  assert.deepEqual((await confirm(paymentId, s.body.sms.code)).body, ok.body);
  assert.equal((await card(paymentId)).status, 409, 'a paid payment takes no card');
});

test('another card → card_not_supported (422), the payment does not change', async () => {
  const { paymentId } = await pay();
  const r = await card(paymentId, '4242 4242 4242 4242');
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'card_not_supported');
  assert.equal(r.body.message, 'Это учебный эмулятор: используйте тестовую карту из подсказки.');
  assert.equal((await payment(paymentId)).status, 'pending');
  assert.equal((await post(`/api/payments/${paymentId}/card`, { number: '4242 4242 4242 4242', expiry: '12/29', lang: 'en' })).body.message,
    'This is a training emulator: use a test card from the hint.');
});

test('a wrong code 3 times → failed / code_attempts_exceeded; a new card gives a new code', async () => {
  const { booking, paymentId } = await pay();
  const first = (await card(paymentId)).body.sms.code;
  const second = (await card(paymentId)).body.sms.code;          // the card again: the old code is void, attempts from 0
  const wrong = second === '000000' ? '000001' : '000000';
  if (first !== second) assert.equal((await confirm(paymentId, first)).body.left, 2, 'the old code no longer works');
  else assert.equal((await confirm(paymentId, wrong)).body.left, 2);
  const w2 = await confirm(paymentId, wrong);
  assert.deepEqual([w2.status, w2.body.error, w2.body.left], [422, 'wrong_code', 1]);
  assert.equal(w2.body.message, 'Неверный код. Осталось попыток: 1.');
  const w3 = await confirm(paymentId, wrong);
  assert.equal(w3.status, 200);
  assert.deepEqual([w3.body.status, w3.body.failureReason], ['failed', 'code_attempts_exceeded']);
  assert.equal(w3.body.failureText, 'Код введён неверно 3 раза. Начните оплату заново.');
  assert.equal(await bookingStatus(booking.id), 'held', 'the hold stays: the client may try again');
  assert.equal((await confirm(paymentId, second)).status, 409, 'closed');
  assert.equal((await db.one('SELECT count(*)::int AS n FROM payment_challenges')).n, 0);
});

test('declined and insufficient-funds cards; an expired code → session_expired', async () => {
  for (const [no, number, reason] of [[41, '9860 0000 0000 0000', 'bank_declined'], [42, '8600 0000 0005 0002', 'insufficient_funds']]) {
    const { paymentId } = await pay(no);
    const r = await confirm(paymentId, (await card(paymentId, number)).body.sms.code);
    assert.deepEqual([r.body.status, r.body.failureReason], ['failed', reason]);
  }
  const { paymentId } = await pay(43);
  const code = (await card(paymentId)).body.sms.code;
  fakeClock.advance('301s');
  assert.deepEqual((await confirm(paymentId, code)).body.failureReason, 'session_expired');
});

test('the hold ends mid-payment: the code is right, but no money is taken and there is no booking', async () => {
  const { booking, paymentId } = await pay();
  fakeClock.advance('13m');
  const s = await card(paymentId);
  assert.equal(s.body.codeExpiresAt, new Date(Date.parse('2026-10-28T10:15:00+05:00')).toISOString(), 'not longer than the hold');
  fakeClock.advance('2m');
  const r = await confirm(paymentId, s.body.sms.code);
  assert.deepEqual([r.body.status, r.body.failureReason], ['failed', 'session_expired']);
  assert.notEqual(await bookingStatus(booking.id), 'booked');

  const second = await pay(42);
  const code = (await card(second.paymentId)).body.sms.code;
  await db.query('UPDATE bookings SET expires_at = $2 WHERE id = $1', [second.booking.id, new Date(Date.parse('2026-10-28T10:15:00+05:00'))]);
  await db.query('UPDATE payment_challenges SET expires_at = $1', [new Date(Date.parse('2026-10-28T10:20:00+05:00'))]);
  fakeClock.advance('1s');
  const late = await confirm(second.paymentId, code);
  assert.deepEqual([late.body.status, late.body.failureReason], ['failed', 'hold_expired']);
  assert.equal(await bookingStatus(second.booking.id), 'held', 'not booked (swept later)');
  const third = await card(second.paymentId);
  assert.deepEqual([third.status, third.body.error, third.body.reason], [409, 'payment_closed', 'hold_expired']);
});

test('unknown or malformed payment id → 404', async () => {
  assert.equal((await card('nope')).status, 404);
  assert.equal((await card('00000000-0000-4000-8000-000000000000')).status, 404);
});

test('P6: after an emulator payment no 16 digits in a row anywhere — tables or the log', async () => {
  const logs = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => { logs.push(a.join(' ')); };
  try {
    const { paymentId } = await pay();
    await card(paymentId, '1234 5678 9012 3456');
    await confirm(paymentId, (await card(paymentId)).body.sms.code);
  } finally { Object.assign(console, orig); }
  const CARD = /\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}/;
  assert.ok(!logs.some(l => CARD.test(l)));
  for (const t of ['payments', 'payment_challenges', 'events', 'outbox', 'idempotency_keys', 'jobs']) {
    const rows = await db.query(`SELECT * FROM ${t}`);
    assert.ok(!CARD.test(JSON.stringify(rows)), t);
  }
});
