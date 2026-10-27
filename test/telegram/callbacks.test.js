// 10 §4.4, §6: «Беру клиента» in the staff group (the first wins, the others are told who, a race has one winner, the messages
// of the last 48 h are edited), a button outside the group, the bot leaving the group.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock, now } from '../../server/core/clock.js';
import { enqueue, deliver } from '../../server/core/outbox.js';
import { afterCommit } from '../../server/events/runner.js';
import { createRender } from '../../server/notify/render.js';
import { createSender } from '../../server/notify/telegramSender.js';
import { createTestDb, resetDb } from '../support/db.js';
import { makeClient, makeStaff } from '../support/factories.js';
import { makeBot, callback, myChatMember, ENV, FROM } from './support.js';

let db;
const GROUP = { id: -100500, type: 'supergroup' };
const AZIZ = { id: 501, is_bot: false, first_name: 'Азиз' };
const TIMUR = { id: 502, is_bot: false, first_name: 'Тимур' };
before(async () => { db = await createTestDb(); });
after(() => db.close());
beforeEach(async () => { await resetDb(db); fakeClock.set('2026-10-28T10:00:00+05:00'); });
afterEach(() => fakeClock.reset());

// A bot whose Outbox goes through the same recording Api: sends and edits land in `calls`.
function world() {
  const render = createRender(ENV);
  const work = [];
  let send;
  const made = makeBot(db, { env: ENV, core: { env: ENV, render, onCommit: fx => work.push(afterCommit(db, fx, { env: ENV, send })) } });
  send = createSender({ api: made.bot.api });
  // a message of the group, sent (the Outbox row carries the Telegram message id)
  const post = async (clientId, template = 'staff_booking_paid', key = `${template}:${clientId}:${now().getTime()}`) => {
    const row = await enqueue(db, { template, audience: 'staff_group', dedupeKey: key,
      vars: { bookingNo: 1042, apt: 41, rooms: 2, area: 82.4, price: 612_000_000, name: 'Аня', phoneMasked: '+998 90 *** ** 67', channel: 'telegram',
        deposit: 10_000_000, provider: 'card', until: '2026-10-30T05:00:00.000Z', context: '', clientId } }, { env: ENV, render });
    await deliver(db, [row.id], send);
    return db.one('SELECT * FROM outbox WHERE id = $1', [row.id]);
  };
  const press = async (data, from, chat = GROUP) => { await made.bot.handleUpdate(callback(data, from, chat)); await Promise.all(work.splice(0)); };
  const answers = () => made.calls.filter(c => c.method === 'answerCallbackQuery').map(c => c.payload);
  const edits = () => made.calls.filter(c => c.method === 'editMessageText').map(c => c.payload);
  return { ...made, post, press, answers, edits };
}

async function team() {
  const client = await makeClient(db, { name: 'Аня' });
  const aziz = await makeStaff(db, { login: 'aziz', name: 'Азиз', tg: AZIZ.id });
  const timur = await makeStaff(db, { login: 'timur', name: 'Тимур', tg: TIMUR.id });
  return { client, aziz, timur };
}
const owner = id => db.one('SELECT assigned_staff_id, assigned_at FROM clients WHERE id = $1', [id]);

test('«Беру клиента»: the client is assigned, the event is written, every message with the button is edited, the button is gone', async () => {
  const { client, aziz } = await team();
  const w = world();
  const first = await w.post(client.id);
  fakeClock.advance('2h');
  const second = await w.post(client.id, 'staff_booking_paid', 'second');
  const other = await w.post((await makeClient(db, { name: 'Борис' })).id, 'staff_booking_paid', 'other');

  await w.press(`take:${client.id}`, AZIZ);
  assert.equal((await owner(client.id)).assigned_staff_id, aziz.id);
  assert.deepEqual(w.answers().at(-1), { callback_query_id: w.answers().at(-1).callback_query_id, text: 'Клиент закреплён за вами' });
  const ev = await db.one("SELECT * FROM events WHERE type = 'client.assigned'");
  assert.deepEqual([ev.client_id, ev.staff_id], [client.id, aziz.id]);

  const edited = w.edits();
  assert.deepEqual(edited.map(e => e.message_id).sort(), [Number(first.tg_message_id), Number(second.tg_message_id)].sort(), 'the other client is untouched');
  for (const e of edited) {
    assert.equal(e.chat_id, -100500);
    assert.match(e.text, /\n\n✅ Взял Азиз$/);
    assert.match(e.text, /^💰 Бронь №1042/, 'the original text stays');
    assert.deepEqual(e.reply_markup.inline_keyboard.flat().map(b => b.text), ['🔗 Открыть в админке']);
  }
  const rows = await db.query("SELECT status, op FROM outbox WHERE template = 'staff_lead_taken'");
  assert.deepEqual(rows.map(r => [r.op, r.status]), [['edit', 'sent'], ['edit', 'sent']]);
  assert.equal(Number(other.tg_message_id) > 0, true);
});

test('the second manager: «Клиента уже взял Азиз» as an alert, nothing changes, nothing is edited again; the same manager is told so', async () => {
  const { client, aziz } = await team();
  const w = world();
  await w.post(client.id);
  await w.press(`take:${client.id}`, AZIZ);
  const edits = w.edits().length;

  await w.press(`take:${client.id}`, TIMUR);
  const a = w.answers().at(-1);
  assert.deepEqual([a.text, a.show_alert], ['Клиента уже взял Азиз', true]);
  assert.equal((await owner(client.id)).assigned_staff_id, aziz.id);

  await w.press(`take:${client.id}`, AZIZ);
  assert.equal(w.answers().at(-1).text, 'Этот клиент уже закреплён за вами');
  assert.equal(w.edits().length, edits);
  assert.equal((await db.query("SELECT 1 FROM events WHERE type = 'client.assigned'")).length, 1);
});

test('a race of two managers: exactly one wins, the other gets the alert', async () => {
  const { client } = await team();
  const w = world();
  await w.post(client.id);
  await Promise.all([w.bot.handleUpdate(callback(`take:${client.id}`, AZIZ, GROUP)), w.bot.handleUpdate(callback(`take:${client.id}`, TIMUR, GROUP))]);
  const texts = w.answers().map(a => a.text).sort();
  assert.equal(texts.filter(x => x === 'Клиент закреплён за вами').length, 1, texts.join(' | '));
  assert.equal(texts.filter(x => /^Клиента уже взял /.test(x)).length, 1);
  assert.equal((await db.query("SELECT 1 FROM events WHERE type = 'client.assigned'")).length, 1);
});

test('messages older than 48 hours are not edited; the assignment still holds', async () => {
  const { client } = await team();
  const w = world();
  await w.post(client.id);
  fakeClock.advance('49h');
  const fresh = await w.post(client.id, 'staff_booking_paid', 'fresh');
  await w.press(`take:${client.id}`, AZIZ);
  assert.deepEqual(w.edits().map(e => e.message_id), [Number(fresh.tg_message_id)]);
});

test('a Telegram account that is not linked to a staff member: the alert tells how to link; nothing is assigned', async () => {
  const { client } = await team();
  const w = world();
  await w.press(`take:${client.id}`, { id: 999, is_bot: false, first_name: 'Гость' });
  const a = w.answers().at(-1);
  assert.deepEqual([a.text, a.show_alert], ['Привяжите Telegram в админке: Профиль → Привязать Telegram', true]);
  assert.equal((await owner(client.id)).assigned_staff_id, null);

  await db.query('UPDATE staff SET active = false');
  await w.press(`take:${client.id}`, AZIZ);
  assert.equal(w.answers().at(-1).text, 'Привяжите Telegram в админке: Профиль → Привязать Telegram', 'a deactivated account cannot take');
});

test('outside the group the button is not for you (a forwarded message); a bad id and an unknown client are harmless', async () => {
  const { client } = await team();
  const w = world();
  await w.press(`take:${client.id}`, AZIZ, { id: AZIZ.id, type: 'private' });
  assert.deepEqual([w.answers().at(-1).text, w.answers().at(-1).show_alert], ['Эта кнопка не для вас', true]);
  assert.equal((await owner(client.id)).assigned_staff_id, null);

  await w.press('take:not-a-uuid', AZIZ);                                   // falls to the generic handler: the clock stops
  assert.equal(w.answers().at(-1).text, undefined);
  await w.press('take:00000000-0000-4000-8000-000000000000', AZIZ);
  assert.equal(w.answers().at(-1).text, 'Эта кнопка не для вас');
});

test('a merged client: the card that absorbed it is assigned', async () => {
  const { client, aziz } = await team();
  const winner = await makeClient(db, { name: 'Аня', phone: '+998901234567' });
  await db.query('UPDATE clients SET merged_into = $2 WHERE id = $1', [client.id, winner.id]);
  const w = world();
  await w.press(`take:${client.id}`, AZIZ);
  assert.equal((await owner(winner.id)).assigned_staff_id, aziz.id);
});

test('the bot is removed from the group: the Outbox skips the group («blocked»); added back — messages go again', async () => {
  const { client } = await team();
  const w = world();
  await w.bot.handleUpdate(myChatMember('kicked'));
  const lost = await w.post(client.id, 'staff_booking_paid', 'lost');
  assert.deepEqual([lost.status, lost.skip_reason], ['skipped', 'blocked']);
  assert.equal(w.sent().length, 0);

  await w.bot.handleUpdate(myChatMember('administrator'));
  const back = await w.post(client.id, 'staff_booking_paid', 'back');
  assert.equal(back.status, 'sent');
  assert.equal(w.sent().length, 1);

  await w.bot.handleUpdate(myChatMember('left'));
  assert.equal((await w.post(client.id, 'staff_booking_paid', 'again')).skip_reason, 'blocked');
  await w.bot.handleUpdate(myChatMember('left', { id: -999, type: 'supergroup' }));                  // another chat: not our business
  assert.equal((await db.one("SELECT value FROM settings WHERE key = 'staff_chat'")).value.state, 'removed');
  await w.bot.handleUpdate(myChatMember('member'));
  assert.equal((await db.one("SELECT value FROM settings WHERE key = 'staff_chat'")).value.state, 'ok');
});

test('the dead «Связаться с менеджером» button under a reminder answers with an alert instead of spinning', async () => {
  const w = world();
  await w.press('mgr', FROM, { id: FROM.id, type: 'private' });
  assert.equal(w.answers().at(-1).show_alert, true);
  assert.match(w.answers().at(-1).text, /скоро появится/);
});
