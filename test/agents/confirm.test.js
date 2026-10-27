// 07 §8, §15 agents/confirm: draft → «Да» → the core called with the row's arguments (the model cannot change them); a double
// «Да»; expired; someone else's dialog; the text «да» with two drafts; the card is code, not model text.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock } from '../../server/core/clock.js';
import { createTools } from '../../server/tools/registry.js';
import { isConsent, parseCallback, confirmCard, answerDraft, textConsent } from '../../server/agents/confirm.js';
import { createTestDb, resetDb } from '../support/db.js';
import { makeClient, asClient } from '../support/factories.js';

let db, tools;
const ENV = { TELEGRAM_STAFF_CHAT_ID: '-1', LINK_SECRET: 'test-secret', PUBLIC_URL: 'https://x.test' };
before(async () => { db = await createTestDb(); tools = createTools({ db, env: ENV }); });
after(() => db.close());
beforeEach(async () => { await resetDb(db); fakeClock.set('2026-10-28T10:00:00+05:00'); });
afterEach(() => fakeClock.reset());

async function chat(name = 'Аня', phone = '+998901234567') {
  const c = await makeClient(db, { name, phone, channel: 'telegram' });
  const conv = await db.one(`INSERT INTO conversations (kind, client_id, channel, lang, created_at, updated_at)
    VALUES ('client', $1, 'telegram', 'ru', $2, $2) RETURNING id`, [c.id, new Date('2026-10-28T05:00:00Z')]);
  return { actor: asClient(c, 'telegram'), source: 'agent', lang: 'ru', conversationId: conv.id };
}

test('the consent words: the whole message only', () => {
  for (const yes of ['Да', 'да!', ' ДА. ', 'Ha', 'xa', 'Yes 👍', 'Подтверждаю']) assert.ok(isConsent(yes), yes);
  for (const no of ['да, но №42', 'нет', 'да да', 'yes please', '', null, 'давай']) assert.ok(!isConsent(no), String(no));
});

test('callback data pa:<id>:y|e|n|r fits 64 bytes', () => {
  const id = '6f1c2d3e-4a5b-4c6d-8e7f-001122334455';
  assert.deepEqual(parseCallback(`pa:${id}:y`), { pendingActionId: id, answer: 'yes' });
  assert.deepEqual(parseCallback(`pa:${id}:n`).answer, 'cancel');
  assert.equal(parseCallback(`pa:${id}:x`), null);
  assert.ok(Buffer.byteLength(`pa:${id}:y`) <= 64);
});

test('07 §8.2: the card is built from the preview by code — the exact terms, three buttons', async () => {
  const ctx = await chat();
  const d = await tools.run('create_booking', { apartmentNo: 41 }, ctx);
  const card = confirmCard(d, 'ru', ENV);
  card.data.lines = card.data.lines.map(l => l.replaceAll(String.fromCharCode(160), " "));   // sums keep non-breaking spaces
  assert.equal(card.type, 'confirm');
  assert.equal(card.data.title, 'Бронь квартиры №41');
  assert.ok(card.data.lines.includes('Цена: 1 024 500 000 сум'));
  assert.ok(card.data.lines.includes('Депозит: 10 000 000 сум — засчитывается в первый взнос'));
  assert.ok(card.data.lines.includes('Квартира удерживается 15 минут для оплаты'));
  assert.deepEqual(card.data.buttons.map(b => b.data), ['y', 'e', 'n'].map(a => `pa:${d.pendingActionId}:${a}`));
  const v = await tools.run('book_viewing', { no: 41, datetime: '2026-10-30T15:00' }, ctx);
  assert.deepEqual(confirmCard(v, 'en', ENV).data.lines, ['When: 2026-10-30 15:00 (Tashkent time)']);
});

test('«Да» → the core with the arguments of the row, not of the model; the reply has the pay link', async () => {
  const ctx = await chat();
  const d = await tools.run('create_booking', { apartmentNo: 41 }, ctx);
  // the model «changes its mind» after the draft: a new run would only make a new draft — the button still means №41
  const r = await answerDraft(tools, { pendingActionId: d.pendingActionId, answer: 'yes' }, { ...ctx, args: { apartmentNo: 42 } }, ENV);
  assert.equal(r.status, 'executed');
  assert.equal(r.result.data.apartmentNo, 41);
  assert.equal((await db.one('SELECT apartment_no FROM bookings')).apartment_no, 41);
  assert.match(r.text, /^Готово! Квартира №41 удерживается до 10:15\. Оплатить: https:\/\/x\.test\/b\//);
  assert.deepEqual(r.suggestions.map(s => s.url ? 'url' : s.intent), ['url', 'url', 'my_bookings']);
  const twice = await answerDraft(tools, { pendingActionId: d.pendingActionId, answer: 'yes' }, ctx, ENV);
  assert.equal(twice.error, 'confirm_used');
  assert.equal(twice.text, 'Это действие уже выполнено.');
  assert.equal((await db.query('SELECT 1 FROM bookings')).length, 1);
});

test('expired → «Повторить?» with a retry button that makes a new draft; someone else\'s dialog → not for you', async () => {
  const ctx = await chat();
  const d = await tools.run('create_booking', { apartmentNo: 41 }, ctx);
  const other = await chat('Борис', '+998907654321');
  const alien = await answerDraft(tools, { pendingActionId: d.pendingActionId, answer: 'yes' }, other, ENV);
  assert.equal(alien.error, 'confirm_mismatch');
  assert.equal(alien.text, 'Это подтверждение не для вас.');
  fakeClock.set('2026-10-28T10:11:00+05:00');
  const late = await answerDraft(tools, { pendingActionId: d.pendingActionId, answer: 'yes' }, ctx, ENV);
  assert.equal(late.status, 'expired');
  assert.equal(late.text, 'Время подтверждения вышло. Повторить?');
  const retry = parseCallback(late.suggestions[0].data);
  assert.equal(retry.answer, 'retry');
  const again = await answerDraft(tools, retry, ctx, ENV);
  assert.equal(again.status, 'pending');
  assert.equal(again.blocks[0].type, 'confirm');
  assert.equal((await answerDraft(tools, { pendingActionId: again.pendingActionId, answer: 'yes' }, ctx, ENV)).status, 'executed');
});

test('«Изменить» / «Отмена» cancel the draft; it cannot be confirmed after', async () => {
  const ctx = await chat();
  const d = await tools.run('create_booking', { apartmentNo: 41 }, ctx);
  const n = await answerDraft(tools, { pendingActionId: d.pendingActionId, answer: 'cancel' }, ctx, ENV);
  assert.deepEqual([n.status, n.text], ['cancelled', 'Хорошо, не бронирую.']);
  assert.equal((await answerDraft(tools, { pendingActionId: d.pendingActionId, answer: 'yes' }, ctx, ENV)).error, 'pending_not_found');
  const v = await tools.run('book_viewing', { no: 41, datetime: '2026-10-30T15:00' }, ctx);
  assert.equal((await answerDraft(tools, { pendingActionId: v.pendingActionId, answer: 'edit' }, ctx, ENV)).text.startsWith('Что поменять?'), true);
});

test('07 §3.3: the text «да» executes the only draft; with two drafts (or none, or other words) → the ordinary turn', async () => {
  const ctx = await chat();
  assert.equal(await textConsent(tools, 'да', ctx, ENV), null, 'no draft');
  const d = await tools.run('create_booking', { apartmentNo: 41 }, ctx);
  await tools.run('book_viewing', { no: 41, datetime: '2026-10-30T15:00' }, ctx);
  assert.equal(await textConsent(tools, 'да', ctx, ENV), null, 'two drafts — which one?');
  await tools.decline((await tools.pendingOf(ctx.conversationId)).find(r => r.tool === 'book_viewing').id, ctx);
  assert.equal(await textConsent(tools, 'да, но лучше №42', ctx, ENV), null, 'other words');
  const r = await textConsent(tools, 'Да!', ctx, ENV);
  assert.equal(r.status, 'executed');
  assert.equal(r.result.data.apartmentNo, 41);
  assert.equal((await db.one('SELECT status FROM pending_actions WHERE id = $1', [d.pendingActionId])).status, 'executed');
});
