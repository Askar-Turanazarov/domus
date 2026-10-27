// Hold T1 (03 §4): one transaction, one active record per apartment (I1), sold (I10), limit BR-06 (I11), races (15 §3.3).
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock } from '../../server/core/clock.js';
import { createHold, previewHold, recordConsent, releaseHold, getBooking } from '../../server/core/bookings.js';
import { markSold, statusMap } from '../../server/core/apartments.js';
import { DEFAULT_SETTINGS } from '../../server/core/defaults.js';
import { parseRef, checkSig } from '../../server/core/links.js';
import { createTestDb, resetDb } from '../support/db.js';
import { makeStaff, asStaff, asClient } from '../support/factories.js';

let db;
const ENV = { TELEGRAM_STAFF_CHAT_ID: '-1', LINK_SECRET: 'test-secret' };
const CONSENT = { version: DEFAULT_SETTINGS.offer_version };
const ANYA = { name: 'Аня', phone: '+998901234567' };
const WEB = { type: 'client', id: null, role: 'client', channel: 'web' };
before(async () => { db = await createTestDb(); });
after(() => db.close());
beforeEach(async () => { await resetDb(db); fakeClock.set('2026-10-28T10:00:00+05:00'); });
afterEach(() => fakeClock.reset());

const hold = (apartmentNo, client = ANYA, extra = {}) =>
  createHold(db, { apartmentNo, client, consent: CONSENT, channel: 'web', ...extra }, WEB, { env: ENV });

test('hold: 15 minutes, deposit snapshot, event, hold.expire job, personal link', async () => {
  const r = await hold(41);
  assert.equal(r.booking.status, 'held');
  assert.equal(r.holdSeconds, 15 * 60);
  assert.equal(Number(r.booking.deposit_amount), DEFAULT_SETTINGS.deposit_amount);
  assert.equal(r.booking.consent_version, CONSENT.version);
  const ref = parseRef(r.link.slice(3));
  assert.equal(ref.no, r.booking.no);
  assert.ok(checkSig('booking', r.booking, ref.sig, ENV));
  assert.equal((await statusMap(db))[41], 'held');
  const job = await db.one("SELECT * FROM jobs WHERE type = 'hold.expire'");
  assert.equal(job.payload.bookingId, r.booking.id);
  assert.equal(job.payload.expectedExpiresAt, r.booking.expires_at.toISOString());
  assert.equal((await db.query("SELECT 1 FROM events WHERE type = 'booking.held'")).length, 1);
  assert.equal((await db.query('SELECT 1 FROM outbox')).length, 0, 'a browser hold sends no Telegram message');
});

test('consent: required in the browser, must be the current offer; a chat hold takes it on the payment page', async () => {
  await assert.rejects(hold(41, ANYA, { consent: null }), { code: 'consent_required' });
  await assert.rejects(hold(41, ANYA, { consent: { version: '2020-01-01' } }), { code: 'consent_required' });
  const r = await createHold(db, { apartmentNo: 41, client: { telegram: { userId: 77, chatId: 77 } }, channel: 'telegram' },
    { type: 'client', id: null, role: 'client', channel: 'telegram' }, { env: ENV });
  assert.equal(r.booking.consent_version, null);
  assert.equal((await db.one('SELECT template FROM outbox')).template, 'hold_created');
  await assert.rejects(recordConsent(db, { bookingId: r.booking.id, version: 'x' }, WEB), { code: 'consent_required' });
  const b = await recordConsent(db, { bookingId: r.booking.id, version: CONSENT.version }, WEB);
  assert.equal(b.consent_version, CONSENT.version);
});

test('I1: the same client again gets the same hold; another client — apartment_not_free; a booked one — already_booked_by_you', async () => {
  const a = await hold(41);
  const again = await hold(41);
  assert.equal(again.booking.id, a.booking.id);
  await assert.rejects(hold(41, { name: 'Борис', phone: '+998907654321' }), { code: 'apartment_not_free' });
  await db.query(`UPDATE bookings SET status = 'booked', booked_at = held_at WHERE id = $1`, [a.booking.id]);
  await assert.rejects(hold(41), { code: 'already_booked_by_you' });
});

test('I10: a sold apartment cannot be held; unknown apartment → apartment_not_found', async () => {
  const head = await makeStaff(db, { login: 'boss', role: 'head' });
  await markSold(db, { apartmentNo: 10 }, asStaff(head), { env: ENV });
  await assert.rejects(hold(10), { code: 'apartment_sold' });
  await assert.rejects(hold(9999), { code: 'apartment_not_found' });
});

test('one hold per client: a new hold releases the previous one', async () => {
  const a = await hold(41);
  const b = await hold(42);
  assert.equal((await getBooking(db, a.booking.id)).status, 'released');
  assert.equal(b.booking.status, 'held');
  assert.equal((await db.one("SELECT data FROM events WHERE type = 'booking.released'")).data.reason, 'replaced');
});

test('I11: BR-06 counts booked records, also of other cards with the same phone', async () => {
  const a = await hold(41);
  await db.query(`UPDATE bookings SET status = 'booked', booked_at = held_at, expires_at = $2 WHERE id = $1`,
    [a.booking.id, new Date(Date.parse('2026-10-31T10:00:00+05:00'))]);
  const b = await hold(42, { name: 'Анна', phone: ANYA.phone });       // R4: another card, same phone
  assert.notEqual(b.booking.client_id, a.booking.client_id);
  await db.query(`UPDATE bookings SET status = 'booked', booked_at = held_at, expires_at = $2 WHERE id = $1`,
    [b.booking.id, new Date(Date.parse('2026-10-31T10:00:00+05:00'))]);
  await assert.rejects(hold(43), { code: 'booking_limit' });
  const p = await previewHold(db, { apartmentNo: 43, clientId: a.booking.client_id });
  assert.equal(p.available, false);
  assert.equal(p.reason, 'booking_limit');
});

test('an expired hold is swept by the next hold of the apartment (layer 2), with its event and message', async () => {
  const a = await createHold(db, { apartmentNo: 41, client: { telegram: { userId: 77, chatId: 77 } }, channel: 'telegram' },
    WEB, { env: ENV });
  fakeClock.advance('16m');
  assert.equal((await getBooking(db, a.booking.id)).status, 'hold_expired', 'I12: read sees it over before any sweep');
  assert.equal((await statusMap(db))[41], 'free');
  const b = await hold(41, { name: 'Борис', phone: '+998907654321' });
  assert.equal(b.booking.status, 'held');
  const old = await db.one('SELECT * FROM bookings WHERE id = $1', [a.booking.id]);
  assert.equal(old.status, 'hold_expired');
  assert.equal(old.closed_at.getTime(), a.booking.expires_at.getTime(), 'closed at its deadline, not at the sweep');
  assert.deepEqual((await db.query('SELECT template FROM outbox ORDER BY id')).map(o => o.template), ['hold_created', 'hold_expired']);
});

test('idempotency: the same key returns the same hold; another body with the key — idempotency_conflict', async () => {
  const a = await hold(41, ANYA, { idempotencyKey: 'k1' });
  const b = await hold(41, ANYA, { idempotencyKey: 'k1' });
  assert.equal(a.booking.id, b.booking.id);
  await assert.rejects(hold(42, ANYA, { idempotencyKey: 'k1' }), { code: 'idempotency_conflict' });
});

test('release: the client gives up a hold; then it is closed', async () => {
  const a = await hold(41);
  const me = asClient({ id: a.booking.client_id });
  await assert.rejects(releaseHold(db, { bookingId: a.booking.id }, asClient({ id: '00000000-0000-0000-0000-000000000000' })), { code: 'forbidden' });
  const r = await releaseHold(db, { bookingId: a.booking.id }, me);
  assert.equal(r.status, 'released');
  assert.equal((await db.one("SELECT status FROM jobs WHERE type = 'hold.expire'")).status, 'cancelled');
  await assert.rejects(releaseHold(db, { bookingId: a.booking.id }, me), { code: 'booking_closed' });
});

test('races (15 §3.3): two clients hold one apartment at once → one held, one apartment_not_free', async () => {
  const rs = await Promise.allSettled([hold(41), hold(41, { name: 'Борис', phone: '+998907654321' })]);
  assert.equal(rs.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(rs.find(r => r.status === 'rejected').reason.code, 'apartment_not_free');
  assert.equal((await db.query("SELECT 1 FROM bookings WHERE status = 'held'")).length, 1);
});

test('races: hold and markSold of one apartment — never both', async () => {
  const head = await makeStaff(db, { login: 'boss', role: 'head' });
  const rs = await Promise.allSettled([hold(41), markSold(db, { apartmentNo: 41 }, asStaff(head), { env: ENV })]);
  assert.equal(rs.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(['apartment_held', 'apartment_sold'].includes(rs.find(r => r.status === 'rejected').reason.code));
});
