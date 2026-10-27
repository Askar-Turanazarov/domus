// 10 §4.2 «Поделиться телефоном» (FR-TG-05, R2): the own contact verifies the phone and glues the site card; a foreign one is refused.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock } from '../../server/core/clock.js';
import { createTestDb, resetDb } from '../support/db.js';
import { makeClient, makeBooking } from '../support/factories.js';
import { makeBot, start, contact, buttons, FROM } from './support.js';

let db;
before(async () => { db = await createTestDb(); });
after(() => db.close());
beforeEach(async () => { await resetDb(db); fakeClock.set('2026-10-28T10:00:00+05:00'); });
afterEach(() => fakeClock.reset());

const me = () => db.one('SELECT * FROM clients WHERE telegram_user_id = $1', [FROM.id]);

test('own contact: phone_verified, the site card with this number joins, the menu loses the share button', async () => {
  const web = await makeClient(db, { name: 'Аня', phone: '+998901234567' });
  const b = await makeBooking(db, { apartmentNo: 41, clientId: web.id, status: 'booked', minutes: 600 });
  const { bot, sent } = makeBot(db);
  await bot.handleUpdate(start());
  assert.equal(buttons(sent().at(-1)).length, 3, 'the share button is in the menu');
  await bot.handleUpdate(contact('998901234567', FROM.id));
  const c = await me();
  assert.deepEqual([c.phone, c.phone_verified], ['+998901234567', true]);
  assert.equal((await db.one('SELECT merged_into FROM clients WHERE id = $1', [web.id])).merged_into, c.id);
  assert.equal((await db.one('SELECT client_id FROM bookings WHERE id = $1', [b.id])).client_id, c.id, 'the booking follows the person');
  assert.equal(sent().at(-1).payload.text, 'Спасибо! Номер подтверждён.');
  assert.equal(buttons(sent().at(-1)).length, 2, 'no share button any more');
  assert.equal((await db.query("SELECT 1 FROM events WHERE type = 'client.phone_verified'")).length, 1);
});

test('a foreign contact is refused: nothing is verified, the button stays', async () => {
  const { bot, sent } = makeBot(db);
  await bot.handleUpdate(start());
  await bot.handleUpdate(contact('998901234567', 999));
  assert.match(sent().at(-1).payload.text, /своим номером/);
  assert.deepEqual([(await me()).phone, (await me()).phone_verified], [null, false]);
  await bot.handleUpdate(contact('998901234567', undefined));
  assert.match(sent().at(-1).payload.text, /своим номером/, 'a contact without user_id is not proof either');
  assert.equal(buttons(sent().at(-1)).length, 3);
});

test('a number verified by another Telegram is not taken: a hint for managers, a polite answer', async () => {
  const owner = await makeClient(db, { name: 'Борис', phone: '+998901234567', verified: true, tg: 500 });
  const { bot, sent } = makeBot(db);
  await bot.handleUpdate(start());
  await bot.handleUpdate(contact('+998 90 123 45 67', FROM.id));
  const c = await me();
  assert.deepEqual([c.phone_verified, c.possible_duplicate_of], [false, owner.id]);
  assert.match(sent().at(-1).payload.text, /уже подтверждён в другом/);
  assert.equal((await db.query("SELECT 1 FROM events WHERE type = 'client.merge_conflict'")).length, 1);
});

test('a foreign number (not Uzbek) shared without a plus is read as international', async () => {
  const { bot } = makeBot(db);
  await bot.handleUpdate(start());
  await bot.handleUpdate(contact('447911123456', FROM.id));
  assert.equal((await me()).phone, '+447911123456');
});
