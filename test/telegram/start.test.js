// 10 §4.1: /start in four forms — R1 (the card of a Telegram user), lk_ (R6), st_ (staff), apt_ (a deep link) — and the language.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock } from '../../server/core/clock.js';
import { issueLinkCode, resolveClient } from '../../server/core/clients.js';
import { issueStaffLinkCode } from '../../server/core/staff.js';
import { createTestDb, resetDb } from '../support/db.js';
import { makeClient, makeStaff, makeBooking } from '../support/factories.js';
import { makeBot, start, text, callback, buttons, FROM, ENV } from './support.js';

let db;
before(async () => { db = await createTestDb(); });
after(() => db.close());
beforeEach(async () => { await resetDb(db); fakeClock.set('2026-10-28T10:00:00+05:00'); });
afterEach(() => fakeClock.reset());

const client = () => db.one('SELECT * FROM clients WHERE telegram_user_id = $1', [FROM.id]);

test('/start: a new user gets a card in their language, the language buttons and the menu', async () => {
  const { bot, sent } = makeBot(db);
  await bot.handleUpdate(start('', { ...FROM, language_code: 'uz-UZ' }));
  const c = await client();
  assert.deepEqual([c.lang, Number(c.telegram_chat_id), c.telegram_username, c.first_channel], ['uz', 77, 'anya', 'telegram']);
  const [pick, menu] = sent();
  assert.match(pick.payload.text, /Tilni tanlang/);
  assert.deepEqual(buttons(pick), [['🇷🇺 Русский', '🇺🇿 O‘zbekcha', '🇬🇧 English']]);
  assert.match(menu.payload.text, /^Assalomu alaykum/);
  assert.deepEqual(buttons(menu), [['🏠 Kvartira tanlash', '🏢 Majmuani ochish'], ['📋 Bronlarim', '👤 Menejer bilan bog‘lanish'], ['📱 Telefonni ulashish']]);
  assert.equal(menu.payload.reply_markup.keyboard[0][1].web_app.url, 'https://domus.test/mini', 'the menu button opens the mini app');
  assert.equal(menu.payload.reply_markup.keyboard[2][0].request_contact, true);
  assert.equal(menu.payload.reply_markup.is_persistent, true);
});

test('/start: an unknown language code → ru; the second /start is the menu only and lifts the «blocked» mark', async () => {
  const { bot, sent } = makeBot(db);
  await bot.handleUpdate(start('', { ...FROM, language_code: 'de' }));
  assert.equal((await client()).lang, 'ru');
  await db.query('UPDATE clients SET tg_blocked_at = $1', [new Date()]);
  const before = sent().length;
  await bot.handleUpdate(start('', { ...FROM, language_code: 'en' }));
  assert.equal(sent().length - before, 1, 'no language buttons for a known user');
  const c = await client();
  assert.equal(c.lang, 'ru', 'the saved language wins over the Telegram one');
  assert.equal(c.tg_blocked_at, null);
  assert.equal((await db.query('SELECT 1 FROM clients')).length, 1);
});

test('/start lk_<code>: the site card gets this Telegram, the Outbox holds «Готово!», the code works once', async () => {
  const web = await makeClient(db, { name: 'Аня', phone: '+998901234567' });
  const b = await makeBooking(db, { apartmentNo: 41, clientId: web.id, status: 'booked', minutes: 600 });
  const code = await db.tx(q => issueLinkCode(q, { clientId: web.id, bookingId: b.id }));
  const { bot, sent } = makeBot(db);
  await bot.handleUpdate(start(`lk_${code}`));
  const c = await client();
  assert.equal(c.id, web.id);
  assert.equal(Number(c.telegram_chat_id), 77);
  const o = await db.one("SELECT * FROM outbox WHERE template = 'link_telegram_done'");
  assert.deepEqual([o.status, Number(o.chat_id), o.vars.bookingNo], ['pending', 77, b.no]);
  assert.match(sent()[0].payload.text, /Выберите действие/);

  await bot.handleUpdate(start(`lk_${code}`, { ...FROM, id: 99 }));
  assert.match(sent().at(-1).payload.text, /Ссылка недействительна/);
  assert.equal(sent().at(-1).payload.chat_id, 99);
  assert.equal((await db.query('SELECT 1 FROM clients WHERE telegram_user_id = 99')).length, 0);
});

test('/start lk_<code>: expired, garbage and a site card already bound to another Telegram → a polite refusal', async () => {
  const web = await makeClient(db, { name: 'Аня' });
  const old = await db.tx(q => issueLinkCode(q, { clientId: web.id }));
  fakeClock.advance('8d');
  const { bot, sent } = makeBot(db);
  await bot.handleUpdate(start(`lk_${old}`));
  await bot.handleUpdate(start('lk_nonsense'));
  assert.deepEqual(sent().map(s => /Ссылка недействительна/.test(s.payload.text)), [true, true]);

  const bound = await makeClient(db, { name: 'Борис', tg: 500 });
  const code = await db.tx(q => issueLinkCode(q, { clientId: bound.id }));
  await bot.handleUpdate(start(`lk_${code}`));
  assert.match(sent().at(-1).payload.text, /уже привязана к другому/);
});

test('/start st_<code>: the staff member is linked, no client card is made; an expired code is refused', async () => {
  const staff = await makeStaff(db, { name: 'Азиз', role: 'manager' });
  const { code } = await db.tx(q => issueStaffLinkCode(q, { staffId: staff.id }));
  const { bot, sent } = makeBot(db);
  await bot.handleUpdate(start(`st_${code}`));
  assert.equal(sent()[0].payload.text, 'Вы привязаны как Азиз (менеджер).');
  const s = await db.one('SELECT * FROM staff WHERE id = $1', [staff.id]);
  assert.deepEqual([Number(s.telegram_user_id), s.telegram_username, s.tg_link_code_hash], [77, 'anya', null]);
  assert.equal((await db.query('SELECT 1 FROM clients')).length, 0);
  assert.equal((await db.query("SELECT 1 FROM events WHERE type = 'staff.telegram_linked'")).length, 1);

  await bot.handleUpdate(start(`st_${code}`, { ...FROM, id: 88 }));
  assert.match(sent().at(-1).payload.text, /недействителен или истёк/, 'a used code does not work again');

  const late = await makeStaff(db, { login: 'timur', name: 'Тимур' });
  const stale = await db.tx(q => issueStaffLinkCode(q, { staffId: late.id }));
  fakeClock.advance('16m');
  await bot.handleUpdate(start(`st_${stale.code}`, { ...FROM, id: 89 }));
  assert.match(sent().at(-1).payload.text, /недействителен или истёк/);
  assert.equal((await db.one('SELECT telegram_user_id FROM staff WHERE id = $1', [late.id])).telegram_user_id, null);
});

test('/start apt_<no>: the menu and the card of the apartment; an unknown number is told so', async () => {
  const { bot, sent } = makeBot(db);
  await bot.handleUpdate(start('apt_41'));
  const card = sent().at(-1);
  assert.match(card.payload.text, /^Квартира №41 · \d+-комн\. · .+ м² · \d+ эт\. · .+ сум · свободна$/);
  assert.equal(card.payload.reply_markup.inline_keyboard[0][0].web_app.url, 'https://domus.test/mini#apt=41', 'the card and the plan in the mini app');
  assert.equal(card.payload.reply_markup.inline_keyboard[1][0].url, 'https://domus.test/ru#apt=41');
  await bot.handleUpdate(start('apt_9999'));
  assert.equal(sent().at(-1).payload.text, 'Квартира №9999 не найдена.');
});

test('/lang and lang:xx: the choice is saved, the clock stops, the menu comes in the new language; text outside the menu gets a hint', async () => {
  const { bot, calls, sent } = makeBot(db);
  await bot.handleUpdate(start());
  await bot.handleUpdate(text('/lang'));
  assert.deepEqual(buttons(sent().at(-1)), [['🇷🇺 Русский', '🇺🇿 O‘zbekcha', '🇬🇧 English']]);
  await bot.handleUpdate(callback('lang:en'));
  assert.equal(calls.find(c => c.method === 'answerCallbackQuery').payload.callback_query_id.startsWith('cb'), true);
  assert.equal((await client()).lang, 'en');
  assert.equal(sent().at(-1).payload.text, 'Language: English.');
  assert.equal(buttons(sent().at(-1))[0][0], '🏠 Find an apartment');

  await bot.handleUpdate(text('How much is a two-room?'));
  assert.match(sent().at(-1).payload.text, /coming soon/);
  await bot.handleUpdate(text('🏠 Find an apartment'));
  assert.match(sent().at(-1).payload.text, /coming soon/);
  const n = sent().length;
  await bot.handleUpdate(text('/nonsense'));
  assert.equal(sent().length, n, 'an unknown command: silence');
});

test('/help: what the bot is, a training project, the privacy link in the language of the client', async () => {
  const { bot, sent } = makeBot(db);
  await resolveClient(db, { telegram: { userId: 77, chatId: 77 }, lang: 'en' }, 'telegram');
  await bot.handleUpdate(text('/help'));
  assert.match(sent().at(-1).payload.text, /training project/);
  assert.match(sent().at(-1).payload.text, /https:\/\/domus\.test\/legal\/privacy\?lang=en/);
});

test('without https in PUBLIC_URL the «Открыть ЖК» button is plain text (web_app needs https)', async () => {
  const { bot, sent } = makeBot(db, { env: { ...ENV, PUBLIC_URL: 'http://localhost:3000' } });
  await bot.handleUpdate(start());
  const menu = sent().at(-1).payload.reply_markup.keyboard;
  assert.equal(menu[0][1].web_app, undefined);
});
