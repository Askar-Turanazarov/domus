// 15 §6.1 on HTTP: the hold → the consent → the card → the SMS code → the booking, with the real entries over PGlite.
// The made-up providers are the card emulator itself (05 §4).
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fakeClock } from '../../server/core/clock.js';
import { createTestDb, resetDb } from '../support/db.js';
import { startApi } from '../support/api.js';

let db, api;
const HUMO_OK = '9860 0000 0009 0001';
const HOLD = { apartmentNo: 41, name: 'Аня', phone: '+998 90 123 45 67', consent: { version: '2026-10-27', privacy: true } };

before(async () => { db = await createTestDb(); api = await startApi(db); });
after(async () => { api.close(); await db.close(); });
beforeEach(async () => { await resetDb(db); fakeClock.set('2026-10-28T10:00:00+05:00'); });
afterEach(() => fakeClock.reset());

const hold = (body = HOLD, o) => api.call('POST', '/api/bookings/hold', body, o);
const refOf = link => link.replace('/b/', '');
const view = ref => api.call('GET', `/api/bookings/by-ref/${ref}`);

test('journey: hold → page data → consent → card → code → booked', async () => {
  const h = await hold();
  assert.equal(h.status, 201, h.text);
  assert.deepEqual(Object.keys(h.body).sort(), ['bookingNo', 'depositAmount', 'expiresAt', 'holdSeconds', 'link']);
  assert.equal(h.body.holdSeconds, 900);
  assert.equal(h.body.depositAmount, 10_000_000);
  assert.equal(h.body.expiresAt, '2026-10-28T10:15:00+05:00');
  assert.match(h.headers.get('set-cookie'), /^dcl=[^;]+; HttpOnly; SameSite=Lax; Path=\/; Max-Age=15552000/);
  const ref = refOf(h.body.link);

  const page = await view(ref);
  assert.equal(page.status, 200);
  assert.deepEqual([page.body.booking.status, page.body.apartment.no, page.body.payment, page.body.refund, page.body.telegramLinked],
    ['held', 41, null, null, false]);
  assert.equal(page.body.serverNow, '2026-10-28T10:00:00+05:00');
  assert.equal(page.body.offerVersion, '2026-10-27');
  assert.ok(!/Аня|998 ?90|\+99890/.test(page.text), 'no name and no phone in the page data (14 §4)');

  assert.deepEqual((await api.call('POST', `/api/bookings/by-ref/${ref}/consent`, { version: '2026-10-27' })).body.consentAt, '2026-10-28T10:00:00+05:00');

  const start = await api.call('POST', '/api/payments', { ref, provider: 'card', lang: 'ru' });
  assert.equal(start.status, 201, start.text);
  assert.match(start.body.code, /^P-/);
  const id = start.body.paymentId;
  assert.equal((await api.call('GET', `/api/payments/${id}`)).body.status, 'pending');

  const card = await api.call('POST', `/api/payments/${id}/card`, { number: HUMO_OK, expiry: '12/29' });
  assert.equal(card.status, 200, card.text);
  const ok = await api.call('POST', `/api/payments/${id}/card/confirm`, { code: card.body.sms.code });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.status, 'succeeded');

  const done = await view(ref);
  assert.deepEqual([done.body.booking.status, done.body.payment.status, done.body.payment.brand, done.body.payment.mask],
    ['booked', 'succeeded', 'HUMO', '9860 •••• 0001']);
  assert.equal(done.body.booking.expiresAt, '2026-10-31T10:00:00+05:00');
  assert.equal((await db.one('SELECT status FROM bookings WHERE no = $1', [h.body.bookingNo])).status, 'booked');
});

test('idempotency: the same key and body → the same answer; another body → 409; no key → 400', async () => {
  const key = crypto.randomUUID();
  const a = await hold(HOLD, { key });
  const b = await hold(HOLD, { key });
  assert.deepEqual([b.status, b.body.bookingNo, b.body.link], [201, a.body.bookingNo, a.body.link]);
  assert.equal((await db.query('SELECT 1 FROM bookings')).length, 1);
  const other = await hold({ ...HOLD, apartmentNo: 42 }, { key });
  assert.deepEqual([other.status, other.body.error], [409, 'idempotency_conflict']);
  const none = await api.call('POST', '/api/bookings/hold', HOLD, { headers: {}, key: null });
  assert.deepEqual([none.status, none.body.error], [400, 'idempotency_key_required']);

  const ref = refOf(a.body.link);
  const pkey = crypto.randomUUID();
  const p1 = await api.call('POST', '/api/payments', { ref, provider: 'card' }, { key: pkey });
  const p2 = await api.call('POST', '/api/payments', { ref, provider: 'card' }, { key: pkey });
  assert.deepEqual([p2.status, p2.body.paymentId], [201, p1.body.paymentId]);
  assert.equal((await db.query('SELECT 1 FROM payments')).length, 1);
  assert.equal((await api.call('POST', '/api/payments', { ref, provider: 'click' }, { key: pkey })).body.error, 'idempotency_conflict');
});

test('13 §1.2: the error answer, texts in the asked language, unknown fields, broken body', async () => {
  const bad = await hold({ ...HOLD, phone: '12' });
  assert.deepEqual([bad.status, bad.body.error, bad.body.message], [422, 'phone_invalid', 'Проверьте номер телефона: +998 XX XXX XX XX.']);
  assert.match(bad.body.requestId, /\S/);
  assert.equal(bad.headers.get('x-request-id'), bad.body.requestId);
  assert.equal((await hold({ ...HOLD, phone: '12', lang: 'en' })).body.message, 'Check the phone number: +998 XX XXX XX XX.');
  assert.equal((await hold({ ...HOLD, phone: '12' }, { headers: { 'accept-language': 'uz-UZ,ru;q=0.5' } })).body.message.startsWith('Telefon'), true);

  const extra = await hold({ ...HOLD, role: 'head' });
  assert.deepEqual([extra.status, extra.body.error, extra.body.fields], [400, 'invalid_input', ['role']]);
  assert.equal(extra.body.message, 'Проверьте поля: role');
  const types = await hold({ ...HOLD, apartmentNo: '41' });
  assert.deepEqual([types.status, types.body.fields], [400, ['apartmentNo']]);
  const noConsent = await hold({ ...HOLD, consent: undefined });
  assert.deepEqual([noConsent.status, noConsent.body.error], [422, 'consent_required']);
  const privacy = await hold({ ...HOLD, consent: { version: '2026-10-27', privacy: false } });
  assert.equal(privacy.body.error, 'invalid_input');
  assert.equal((await hold('{"apartmentNo": ')).body.error, 'invalid_input', 'a broken JSON is our error format too');
  const big = await hold({ ...HOLD, name: 'x'.repeat(70_000) });
  assert.deepEqual([big.status, big.body.error], [413, 'payload_too_large']);
  assert.equal((await hold({ ...HOLD, apartmentNo: 999 })).body.error, 'apartment_not_found');
});

test('personal link: a wrong number, a wrong signature, a junk ref all answer link_invalid', async () => {
  const h = await hold();
  const ref = refOf(h.body.link);
  const [no, sig] = ref.split('-');
  for (const bad of [`${no}-${'a'.repeat(32)}`, `${Number(no) + 1}-${sig}`, `${no}-${sig.slice(1)}`, 'junk', `${no}-${sig}x`]) {
    const r = await view(bad);
    assert.deepEqual([r.status, r.body.error], [404, 'link_invalid'], bad);
  }
  assert.equal((await api.call('POST', `/api/bookings/by-ref/${no}-${'b'.repeat(32)}/release`, {})).body.error, 'link_invalid');
  assert.equal((await api.call('POST', '/api/payments', { ref: `${no}-${'c'.repeat(32)}`, provider: 'card' })).body.error, 'link_invalid');
  assert.equal((await api.call('POST', '/api/payments', { ref: 'o:501-' + sig, provider: 'card' })).body.error, 'invalid_input');
});

test('release and cancel: a hold is released, a paid booking cancelled by the client (deposit stays)', async () => {
  const h = await hold();
  const ref = refOf(h.body.link);
  assert.equal((await api.call('POST', `/api/bookings/by-ref/${ref}/cancel`, {})).body.error, 'booking_not_active', 'a hold is released, not cancelled');
  assert.equal((await api.call('POST', `/api/bookings/by-ref/${ref}/release`, {})).body.status, 'released');
  let page = await view(ref);
  assert.deepEqual([page.body.booking.status, page.body.booking.closedReason], ['released', 'released']);
  assert.equal((await api.call('POST', `/api/bookings/by-ref/${ref}/release`, {})).body.error, 'booking_closed');

  const h2 = await hold();
  const ref2 = refOf(h2.body.link);
  const { body: { paymentId } } = await api.call('POST', '/api/payments', { ref: ref2, provider: 'card' });
  const { body: { sms } } = await api.call('POST', `/api/payments/${paymentId}/card`, { number: HUMO_OK, expiry: '12/29' });
  await api.call('POST', `/api/payments/${paymentId}/card/confirm`, { code: sms.code });
  const c = await api.call('POST', `/api/bookings/by-ref/${ref2}/cancel`, { reason: 'Передумал' });
  assert.deepEqual([c.status, c.body.status], [200, 'cancelled']);
  page = await view(ref2);
  assert.deepEqual([page.body.booking.status, page.body.booking.closedReason, page.body.refund], ['cancelled', 'cancelled_client', null]);
});

test('payment page: cancel by the client, the reason text, a repeated cancel is payment_closed', async () => {
  const h = await hold();
  const ref = refOf(h.body.link);
  const { body: { paymentId } } = await api.call('POST', '/api/payments', { ref, provider: 'card' });
  assert.equal((await api.call('POST', `/api/payments/${paymentId}/cancel`, {})).body.status, 'cancelled');
  const again = await api.call('POST', `/api/payments/${paymentId}/cancel`, {});
  assert.deepEqual([again.status, again.body.error], [409, 'payment_closed']);
  const page = await view(ref);
  assert.deepEqual([page.body.payment.status, page.body.payment.failureReason, page.body.payment.failureText], ['cancelled', 'cancelled_by_user', 'Оплата отменена.']);
  assert.equal((await api.call('GET', '/api/payments/not-a-uuid')).body.error, 'payment_not_found');
  assert.equal((await api.call('GET', `/api/payments/${crypto.randomUUID()}`)).status, 404);
});

test('limits: the 6th hold from one IP in an hour is 429 with Retry-After; the phone and the client limits; the window moves on', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await hold({ ...HOLD, apartmentNo: 10 + i, phone: `+99890111000${i}` })).status, 201);
  const over = await hold({ ...HOLD, apartmentNo: 20, phone: '+998901110099' });
  assert.deepEqual([over.status, over.body.error, over.body.vars.retryAfter], [429, 'rate_limited', 3600 - 0]);
  assert.equal(over.headers.get('retry-after'), '3600');
  assert.match(over.body.message, /Попробуйте через 3600 с/);
  fakeClock.advance('1h');
  assert.equal((await hold({ ...HOLD, apartmentNo: 20, phone: '+998901110099' })).status, 201, 'a new window');
});

test('phone limit: the 4th hold with one phone in an hour is 429', async () => {
  await resetDb(db);
  const mk = n => hold({ ...HOLD, apartmentNo: n });
  // one phone, three tries (even repeats count), the fourth is over (hold:phone 3/h)
  for (let i = 0; i < 3; i++) assert.equal((await mk(30)).status, 201);
  const r = await mk(30);
  assert.deepEqual([r.status, r.body.error], [429, 'rate_limited']);
});

test('honeypot and fast form: the bot gets a made-up 201 and nothing is created; a 1-second form is refused', async () => {
  const bot = await hold({ ...HOLD, website: 'http://spam.example' });
  assert.equal(bot.status, 201);
  assert.equal((await db.query('SELECT 1 FROM bookings')).length, 0);
  const fast = await hold({ ...HOLD, openedAt: '2026-10-28T09:59:59+05:00' });
  assert.deepEqual([fast.status, fast.body.error, fast.body.message], [422, 'invalid_input', 'Подождите секунду и отправьте ещё раз.']);
  const slow = await hold({ ...HOLD, openedAt: '2026-10-28T09:59:50+05:00' });
  assert.equal(slow.status, 201);
});

test('the card emulator: 10 requests a minute per payment, then 429', async () => {
  const h = await hold();
  const { body: { paymentId } } = await api.call('POST', '/api/payments', { ref: refOf(h.body.link), provider: 'card' });
  let last;
  for (let i = 0; i < 11; i++) last = await api.call('POST', `/api/payments/${paymentId}/card`, { number: '1', expiry: '12/29' });
  assert.deepEqual([last.status, last.body.error], [429, 'rate_limited']);
});

test('14 §15: a hold sent from another site\'s page (foreign Origin) is 403; the own Origin and no Origin pass', async () => {
  for (const origin of ['https://evil.example', 'null']) {
    const r = await hold(HOLD, { headers: { origin } });
    assert.deepEqual([r.status, r.body.error], [403, 'forbidden'], origin);
  }
  assert.equal((await db.query('SELECT 1 FROM bookings')).length, 0);
  assert.equal((await hold(HOLD, { headers: { origin: api.base } })).status, 201);
});
