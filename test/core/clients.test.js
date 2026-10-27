// Clients (03 §9, D-06, I4/I6): a typed phone never merges cards; a shared Telegram contact (R2) or a link code (R6) does.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock } from '../../server/core/clock.js';
import { resolveClient, verifyPhone, issueLinkCode, attachTelegram, canonical } from '../../server/core/clients.js';
import { enqueue } from '../../server/core/outbox.js';
import { createTestDb, resetDb } from '../support/db.js';
import { makeClient, makeBooking } from '../support/factories.js';

let db;
const PHONE = '+998901234567';
before(async () => { db = await createTestDb(); });
after(() => db.close());
beforeEach(async () => { await resetDb(db); fakeClock.set('2026-10-28T10:00:00+05:00'); });
afterEach(() => fakeClock.reset());

const site = (who, ch = 'web') => db.tx(q => resolveClient(q, who, ch));

test('R1: a Telegram user gets one card; the second visit finds it and adds the channel', async () => {
  const a = await site({ telegram: { userId: 77, chatId: 77 }, name: 'Аня' }, 'telegram');
  const b = await site({ telegram: { userId: 77, username: 'anya' } }, 'mini_app');
  assert.equal(a.id, b.id);
  assert.equal(b.telegram_username, 'anya');
  assert.deepEqual(b.channels, ['telegram', 'mini_app']);
  assert.equal((await db.query("SELECT 1 FROM events WHERE type = 'client.created'")).length, 1);
});

test('site form: bad name / phone → errors; same phone and name → same card; other name → new card with a hint', async () => {
  await assert.rejects(site({ name: 'А', phone: PHONE }), { code: 'name_invalid' });
  await assert.rejects(site({ name: 'Аня', phone: '123' }), { code: 'phone_invalid' });
  const a = await site({ name: 'Аня Петрова', phone: '+998 90 123-45-67' });
  assert.equal(a.phone, PHONE);
  const b = await site({ name: '  аня  петрова ', phone: PHONE });
  assert.equal(b.id, a.id, 'R4: same number, same name');
  const c = await site({ name: 'Борис', phone: PHONE });
  assert.notEqual(c.id, a.id);
  assert.equal(c.possible_duplicate_of, a.id);
});

test('R3: a phone verified by a Telegram owner is never taken by a form; R5: the cookie keeps its card', async () => {
  const owner = await makeClient(db, { name: 'Аня', phone: PHONE, verified: true, tg: 77 });
  const c = await site({ name: 'Аня', phone: PHONE });
  assert.notEqual(c.id, owner.id);
  assert.equal(c.possible_duplicate_of, owner.id);
  const again = await site({ name: 'Анна', phone: PHONE, cookieId: c.id });
  assert.equal(again.id, c.id);
});

test('I4: two verified cards with one phone are impossible in the base', async () => {
  await makeClient(db, { phone: PHONE, verified: true, tg: 1 });
  await assert.rejects(makeClient(db, { phone: PHONE, verified: true, tg: 2 }), e => e.code === '23505');
});

test('R2: a shared contact verifies the phone and absorbs the site cards with it, their bookings too', async () => {
  const web = await site({ name: 'Аня', phone: PHONE });
  const b = await makeBooking(db, { apartmentNo: 41, clientId: web.id, status: 'booked', minutes: 600 });
  const tg = await site({ telegram: { userId: 77 } }, 'telegram');
  const r = await verifyPhone(db, { clientId: tg.id, phone: PHONE });
  assert.equal(r.conflict, false);
  assert.equal(r.client.phone_verified, true);
  assert.equal(r.client.name, 'Аня', 'the empty name is taken from the absorbed card');
  assert.deepEqual([...r.client.channels].sort(), ['telegram', 'web']);
  assert.equal((await db.one('SELECT client_id FROM bookings WHERE id = $1', [b.id])).client_id, tg.id);
  assert.equal((await canonical(db, web.id)).id, tg.id);
  assert.equal((await db.one("SELECT data FROM events WHERE type = 'client.merged'")).data.rule, 'R2');
});

test('R2 conflict: a number verified by another Telegram is not taken — a hint and client.merge_conflict', async () => {
  const owner = await makeClient(db, { phone: PHONE, verified: true, tg: 1 });
  const other = await site({ telegram: { userId: 2 } }, 'telegram');
  const r = await verifyPhone(db, { clientId: other.id, phone: PHONE });
  assert.equal(r.conflict, true);
  assert.equal(r.client.possible_duplicate_of, owner.id);
  assert.equal(r.client.phone_verified, false);
  assert.equal((await db.query("SELECT 1 FROM events WHERE type = 'client.merge_conflict'")).length, 1);
});

test('R6: a link code joins the site card to the Telegram card once; reused / expired / foreign → errors', async () => {
  const web = await site({ name: 'Аня', phone: PHONE });
  const b = await makeBooking(db, { apartmentNo: 41, clientId: web.id, status: 'booked', minutes: 600 });
  const tg = await site({ telegram: { userId: 77, chatId: 77 } }, 'telegram');
  const code = await db.tx(q => issueLinkCode(q, { clientId: web.id, bookingId: b.id }));
  const r = await attachTelegram(db, { code, telegram: { userId: 77, chatId: 77 } }, { env: {} });
  assert.equal(r.client.id, tg.id);
  assert.equal(r.bookingId, b.id);
  assert.equal((await db.one('SELECT client_id FROM bookings WHERE id = $1', [b.id])).client_id, tg.id);
  assert.equal((await db.one("SELECT template FROM outbox")).template, 'link_telegram_done');
  await assert.rejects(attachTelegram(db, { code, telegram: { userId: 77 } }), { code: 'link_invalid' });

  const web2 = await site({ name: 'Борис', phone: '+998901112233' });
  const old = await db.tx(q => issueLinkCode(q, { clientId: web2.id }));
  fakeClock.advance('8d');
  await assert.rejects(attachTelegram(db, { code: old, telegram: { userId: 88 } }), { code: 'link_invalid' });
  await assert.rejects(attachTelegram(db, { code: 'nonsense', telegram: { userId: 88 } }), { code: 'link_invalid' });

  const fresh = await db.tx(q => issueLinkCode(q, { clientId: web2.id }));
  const r2 = await attachTelegram(db, { code: fresh, telegram: { userId: 88, username: 'boris' } });
  assert.equal(r2.client.id, web2.id, 'no Telegram card yet: the site card gets the Telegram');
  assert.equal(r2.client.telegram_user_id, 88);
  const again = await db.tx(q => issueLinkCode(q, { clientId: web2.id }));
  await assert.rejects(attachTelegram(db, { code: again, telegram: { userId: 99 } }), { code: 'telegram_linked_elsewhere' });
});

// The buyer pays first and links Telegram after: «Бронь подтверждена» was skipped (no_telegram) and goes out with «Готово!».
const skippedConfirmation = (b, clientId) => enqueue(db, { template: 'booking_confirmed', audience: 'client', clientId,
  vars: { apt: 41, until: '2026-10-30T05:00:00.000Z', bookingNo: b.no, deposit: 10_000_000, link: '/booking.html' }, dedupeKey: `booking_confirmed:${b.id}` });
const outboxOf = () => db.query("SELECT template, status, skip_reason, chat_id FROM outbox ORDER BY id");

test('R6: a confirmation skipped before the link is sent right after «Готово!»; an expired hold is not announced', async () => {
  const web = await site({ name: 'Аня', phone: PHONE });
  const b = await makeBooking(db, { apartmentNo: 41, clientId: web.id, status: 'booked', minutes: 600 });
  assert.equal((await skippedConfirmation(b, web.id)).status, 'skipped');
  const code = await db.tx(q => issueLinkCode(q, { clientId: web.id, bookingId: b.id }));
  await attachTelegram(db, { code, telegram: { userId: 77, chatId: 77 } });
  assert.deepEqual((await outboxOf()).map(r => [r.template, r.status, r.chat_id == null ? null : Number(r.chat_id)]),
    [['booking_confirmed', 'skipped', null], ['link_telegram_done', 'pending', 77], ['booking_confirmed', 'pending', 77]]);

  const late = await site({ name: 'Борис', phone: '+998901112233' });
  const gone = await makeBooking(db, { apartmentNo: 42, clientId: late.id, status: 'hold_expired', minutes: -10 });
  await skippedConfirmation(gone, late.id);
  const code2 = await db.tx(q => issueLinkCode(q, { clientId: late.id, bookingId: gone.id }));
  await attachTelegram(db, { code: code2, telegram: { userId: 88, chatId: 88 } });
  assert.equal((await outboxOf()).length, 5, 'only «Готово!» for the lost hold');
});
