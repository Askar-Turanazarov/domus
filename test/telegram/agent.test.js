// 10 §4.3–4.4, §5: free text and menu tasks → the agent; the draft and the final messages; the blocks; the buttons pa:, sg:, sgi:, fb:.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeClock } from '../../server/core/clock.js';
import { ingest } from '../../server/kb/ingest.js';
import { createAi } from '../../server/ai/index.js';
import { createTools } from '../../server/tools/registry.js';
import { createTurns } from '../../server/agents/turn.js';
import { resetDraftMode } from '../../server/telegram/stream.js';
import { fakeProvider } from '../ai/fakes.js';
import { createTestDb, resetDb } from '../support/db.js';
import { makeClient } from '../support/factories.js';
import { makeBot, text, callback, ENV, FROM } from './support.js';

let db, tools;
const quiet = { warn() {}, error() {}, info() {} };
const AI_ENV = { ...ENV, GEMINI_API_KEY: 'x' };
before(async () => { db = await createTestDb(); tools = createTools({ db, env: AI_ENV, log: quiet }); });
after(() => db.close());
beforeEach(async () => { await resetDb(db); fakeClock.set('2026-10-28T10:00:00+05:00'); resetDraftMode(); });
afterEach(() => fakeClock.reset());

const plan = o => ({ text: JSON.stringify({ lang: 'ru', agents: [], tasks: {}, handoff: false, injection: false, ...o }) });
const SMALL = { 'gemini-3.5-flash-lite': [plan({ agents: ['smalltalk'] })] };
const world = (script = {}, botOpts = {}) => {
  const g = fakeProvider('gemini', script);
  const ai = createAi({ db, adapters: { gemini: g, anthropic: null }, env: AI_ENV, log: quiet });
  const turns = createTurns({ db, ai, tools, env: AI_ENV, log: quiet });
  const made = makeBot(db, { env: AI_ENV, turns, tools, ...botOpts });
  return { ...made, g };
};
const verified = () => makeClient(db, { name: 'Аня', phone: '+998901234567', verified: true, tg: FROM.id, chat: FROM.id, channel: 'telegram' });
const sent = calls => calls.filter(c => c.method === 'sendMessage');
const keys = msg => (msg.payload.reply_markup?.inline_keyboard ?? []).flat();
const STRANGER = { id: 99, is_bot: false, first_name: 'Чужой', language_code: 'ru' };

test('10 §4.3: free text → a turn of the agent; «печатает…» first, the final message in HTML, the dialogue is Telegram\'s', async () => {
  const { bot, calls } = world(SMALL);
  await bot.handleUpdate(text('Привет, вы бот?'));
  assert.equal(calls.find(c => c.method === 'sendChatAction').payload.action, 'typing');
  const answers = sent(calls).filter(c => c.payload.parse_mode === 'HTML');
  assert.ok(answers.length >= 1);
  assert.equal(answers[0].payload.link_preview_options.is_disabled, true);
  assert.equal((await db.one('SELECT channel FROM conversations')).channel, 'telegram');
  assert.equal((await db.query("SELECT 1 FROM messages WHERE role = 'user'")).length, 1);
  const m = await db.one("SELECT tg_message_id FROM messages WHERE role = 'assistant'");
  assert.ok(m.tg_message_id > 0, 'the id of the Telegram message is kept');
});

test('10 §5.1: the draft is used while the answer is written (sendMessageDraft), before the final message', async () => {
  const { bot, calls } = world(SMALL);
  await bot.handleUpdate(text('Привет'));
  const names = calls.map(c => c.method);
  assert.ok(names.includes('sendMessageDraft'));
  assert.ok(names.indexOf('sendMessageDraft') < names.lastIndexOf('sendMessage'));
});

test('10 §5.1: no sendMessageDraft in the Bot API → the answer still arrives (typing + the finished message)', async () => {
  const { bot, calls } = world(SMALL, { draft: false });
  await bot.handleUpdate(text('Привет'));
  assert.ok(sent(calls).length >= 1);
});

test('10 §4.2: «Подобрать квартиру» → up to 3 cards, each with «в 3D», «рассрочка», «забронировать»; no model', async () => {
  const { bot, calls, g } = world();
  await bot.handleUpdate(text('🏠 Подобрать квартиру'));
  const cards = sent(calls).filter(c => /Квартира №\d+/.test(c.payload.text));
  assert.ok(cards.length >= 1 && cards.length <= 3);
  const kb = keys(cards[0]);
  assert.ok(kb.some(b => b.url?.startsWith('https://domus.test/ru#apt=')), 'a link to the showcase');
  assert.ok(kb.some(b => /^sgi:calc_installment:\d+$/.test(b.callback_data)));
  assert.ok(kb.some(b => /^sgi:book:\d+$/.test(b.callback_data)));
  assert.ok(kb.every(b => Buffer.byteLength(b.callback_data ?? '') <= 64));
  assert.equal(g.calls.length, 0);
});

test('10 §4.2: «Мои брони» and /bookings are a task of the agent (no «скоро появится»)', async () => {
  const { bot, calls } = world();
  await bot.handleUpdate(text('📋 Мои брони'));
  await bot.handleUpdate(text('/bookings'));
  assert.ok(sent(calls).length >= 2);
  assert.ok(sent(calls).every(c => !/скоро появится/.test(c.payload.text)));
});

test('10 §4.3: a sticker, a voice — «понимаю только текст», no turn', async () => {
  const { bot, calls } = world();
  let id = 9000;
  const upd = extra => ({ update_id: ++id, message: { message_id: 1, date: 1_790_000_000, chat: { id: FROM.id, type: 'private' }, from: FROM, ...extra } });
  await bot.handleUpdate(upd({ sticker: { file_id: 'a', file_unique_id: 'b', type: 'regular', width: 1, height: 1, is_animated: false, is_video: false } }));
  await bot.handleUpdate(upd({ voice: { file_id: 'a', file_unique_id: 'b', duration: 1 } }));
  assert.equal(sent(calls).length, 2);
  assert.match(sent(calls)[0].payload.text, /только текст/);
  assert.equal((await db.query('SELECT 1 FROM conversations')).length, 0);
});

test('10 §4.3: the same dialogue within 24 h, a new one after (the memory and the summary carry over)', async () => {
  const { bot } = world(SMALL);
  await bot.handleUpdate(text('Привет'));
  fakeClock.advance('2h');
  await bot.handleUpdate(text('Ещё вопрос'));
  assert.equal((await db.query('SELECT 1 FROM conversations')).length, 1);
  await db.query(`UPDATE conversations SET summary = 'Хочет двушку до 700 млн', state = '{"focusApartment":41}'`);
  fakeClock.advance('25h');
  await bot.handleUpdate(text('Здравствуйте снова'));
  const rows = await db.query('SELECT * FROM conversations ORDER BY created_at');
  assert.equal(rows.length, 2);
  assert.equal(rows[1].summary, 'Хочет двушку до 700 млн');
  assert.equal(rows[1].state.focusApartment, 41);
});

test('10 §4.4 / 07 §8: «Забронировать» → the card with pa: buttons → «Да» → the hold; the buttons go; a stranger gets an alert', async () => {
  await verified();
  const { bot, calls } = world();
  await bot.handleUpdate(callback('sgi:book:41'));
  const card = sent(calls).find(c => keys(c).some(b => b.callback_data?.startsWith('pa:')));
  assert.ok(card, 'the confirmation card');
  assert.match(card.payload.text, /<b>.*41/);
  const yes = keys(card).find(b => b.callback_data.endsWith(':y')).callback_data;
  assert.ok(Buffer.byteLength(yes) <= 64);

  const before = calls.length;
  await bot.handleUpdate(callback(yes, STRANGER));
  assert.equal(calls.slice(before).find(c => c.method === 'answerCallbackQuery').payload.show_alert, true);
  assert.equal((await db.query('SELECT 1 FROM bookings')).length, 0);

  await bot.handleUpdate(callback(yes));
  assert.equal((await db.one('SELECT apartment_no FROM bookings')).apartment_no, 41);
  assert.ok(calls.some(c => c.method === 'editMessageReplyMarkup'), 'the buttons of the card are removed');
});

test('10 §4.4: «Отмена» on the card cancels the draft', async () => {
  await verified();
  const { bot, calls } = world();
  await bot.handleUpdate(callback('sgi:book:41'));
  const card = sent(calls).find(c => keys(c).some(b => b.callback_data?.startsWith('pa:')));
  const no = keys(card).find(b => b.callback_data.endsWith(':n')).callback_data;
  await bot.handleUpdate(callback(no));
  assert.equal((await db.one('SELECT status FROM pending_actions')).status, 'cancelled');
  assert.equal((await db.query('SELECT 1 FROM bookings')).length, 0);
});

test('10 §4.4: every press is answered (answerCallbackQuery) before the work', async () => {
  const { bot, calls } = world();
  await bot.handleUpdate(callback('sgi:show_free'));
  const i = calls.findIndex(c => c.method === 'answerCallbackQuery');
  const j = calls.findIndex(c => c.method === 'sendChatAction');
  assert.ok(i >= 0 && i < j);
});

test('10 §4.4: sg:<messageId>:<i> runs the hint stored in the answer; someone else\'s message gets an alert; a dead one — a note', async () => {
  const { bot, calls } = world(SMALL);
  await bot.handleUpdate(text('Привет'));
  const m = await db.one("SELECT id FROM messages WHERE role = 'assistant'");
  await db.query('UPDATE messages SET blocks = $2 WHERE id = $1',
    [m.id, JSON.stringify([{ type: 'suggestions', data: [{ label: 'Свободные', intent: 'show_free', payload: {} }] }])]);
  const before = calls.length;
  await bot.handleUpdate(callback(`sg:${m.id}:0`));
  assert.ok(sent(calls.slice(before)).some(c => /Квартира №\d+/.test(c.payload.text)));
  const b2 = calls.length;
  await bot.handleUpdate(callback(`sg:${m.id}:0`, STRANGER));
  assert.equal(calls.slice(b2).find(c => c.method === 'answerCallbackQuery').payload.show_alert, true);
  const b3 = calls.length;
  await bot.handleUpdate(callback(`sg:${m.id}:7`));
  assert.equal(calls.slice(b3).find(c => c.method === 'answerCallbackQuery').payload.show_alert, true);
});

test('07 §16.3: fb:<id>:-1 saves 👎 on an own answer only', async () => {
  const { bot, calls } = world(SMALL);
  await bot.handleUpdate(text('Привет'));
  const m = await db.one("SELECT id FROM messages WHERE role = 'assistant'");
  assert.ok(sent(calls).some(c => keys(c).some(b => b.callback_data === `fb:${m.id}:1`)), 'the 👍/👎 row is under the answer');
  await bot.handleUpdate(callback(`fb:${m.id}:1`, STRANGER));
  assert.equal((await db.one('SELECT feedback FROM messages WHERE id = $1', [m.id])).feedback, null);
  await bot.handleUpdate(callback(`fb:${m.id}:-1`));
  assert.equal((await db.one('SELECT feedback FROM messages WHERE id = $1', [m.id])).feedback, -1);
});

test('10 §5: a failure of the turn is not silent — the client gets the «consultant is unavailable» text', async () => {
  const turns = { runTurn: async () => { throw new Error('boom'); } };
  const { bot, calls } = makeBot(db, { env: AI_ENV, turns, tools });
  await bot.handleUpdate(text('Привет'));
  assert.match(sent(calls).at(-1).payload.text, /Консультант временно недоступен/);
});

test('09 §6 / 10 §5: a knowledge-base answer → «Источники: [1] …» under it and «Источник 1»; the button shows the fragment; a stranger gets an alert', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-'));
  fs.mkdirSync(path.join(root, 'ru'));
  fs.writeFileSync(path.join(root, 'ru', 'handover-date.md'),
    '---\ntitle: Сроки сдачи\ntopic: handover\nupdated: 2026-10-27\n---\n\n## Когда сдача дома\nДом сдаётся в IV квартале 2027 года. Срок ориентировочный.\n');
  await ingest({ db, ai: null, root, log: quiet, sleep: async () => {} });
  const { bot, calls } = world({
    'gemini-3.5-flash-lite': [plan({ agents: ['kb_consultant'] })],
    'gemini-3.8-flash': [{ calls: [{ name: 'search_kb', args: { query: 'Когда сдача дома, срок сдачи?' } }] }, { text: 'Сдача в IV квартале 2027 года [1].' }]
  });
  await bot.handleUpdate(text('Когда сдача дома?'));
  const answer = sent(calls).find(c => /Сдача в IV квартале/.test(c.payload.text));
  assert.match(answer.payload.text, /Источники: \[1\] Сроки сдачи — Когда сдача дома/);
  const src = keys(answer).find(b => /^src:\d+:1$/.test(b.callback_data));
  assert.ok(src, 'the «Источник 1» button');
  assert.ok(keys(answer).some(b => b.callback_data?.startsWith('fb:')));

  const before = calls.length;
  await bot.handleUpdate(callback(src.callback_data));
  const shown = sent(calls.slice(before)).at(-1);
  assert.match(shown.payload.text, /^<b>\[1\] Сроки сдачи — Когда сдача дома<\/b>\nДом сдаётся в IV квартале 2027 года/);
  const b2 = calls.length;
  await bot.handleUpdate(callback(src.callback_data, STRANGER));
  assert.equal(calls.slice(b2).find(c => c.method === 'answerCallbackQuery').payload.show_alert, true);
  assert.equal(sent(calls.slice(b2)).length, 0);
});
