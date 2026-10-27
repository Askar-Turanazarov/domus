// 09 §6, 07 §5.4: [n] that do not exist are removed, the citation block has only the mentioned fragments; the consultant
// answers from the fragments, says «no answer» by code, asks once more for citations; the turn adds the block and the buttons.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeClock } from '../../server/core/clock.js';
import { createAi } from '../../server/ai/index.js';
import { createTools } from '../../server/tools/registry.js';
import { createTurns } from '../../server/agents/turn.js';
import { runAgent } from '../../server/agents/agent.js';
import { applyCitations } from '../../server/kb/citations.js';
import { createKb } from '../../server/kb/retrieve.js';
import { ingest } from '../../server/kb/ingest.js';
import { fakeProvider } from '../ai/fakes.js';
import { createTestDb, resetDb } from '../support/db.js';
import { makeClient, asClient } from '../support/factories.js';
import { fakeEmbedAi } from './support.js';

const chunks = [
  { n: 1, id: 10, heading: 'Сроки сдачи — Когда сдача дома', text: 'Дом сдаётся в IV квартале 2027 года.', doc: 'handover-date', score: 0.8 },
  { n: 2, id: 11, heading: 'Паркинг — Подземный паркинг', text: 'Под домом есть паркинг.', doc: 'parking', score: 0.6 },
  { n: 3, id: 12, heading: 'Офис — Часы', text: 'С 9 до 18.', doc: 'sales-office', score: 0.5 }
];

test('09 §6: a number that is not in the result is removed; the block holds only the mentioned fragments, once each', () => {
  const r = applyCitations('Сдача в IV квартале 2027 [1]. Паркинг есть [2] [7]. Повтор [1].', chunks);
  assert.equal(r.text, 'Сдача в IV квартале 2027 [1]. Паркинг есть [2]. Повтор [1].');
  assert.deepEqual(r.used, [1, 2]);
  assert.deepEqual(r.citations.map(c => c.n), [1, 2]);
  assert.deepEqual(r.citations[0], { n: 1, heading: chunks[0].heading, text: chunks[0].text, doc: 'handover-date', score: 0.8 });
});

test('09 §6: no [n] at all → used is empty; [0] and [4] with 3 fragments are both foreign', () => {
  assert.deepEqual(applyCitations('Без ссылок.', chunks).used, []);
  const r = applyCitations('Факт [0] и факт [4].', chunks);
  assert.equal(r.text, 'Факт и факт.');
  assert.deepEqual(r.citations, []);
});

// ---- the consultant on a fake model and a real base (fake vectors) ----
let db, tools, kb, root;
const ENV = { TELEGRAM_STAFF_CHAT_ID: '-1', LINK_SECRET: 'test-secret', PUBLIC_URL: 'https://x.test', GEMINI_API_KEY: 'x', KB_MIN_SCORE: '0.40' };
const quiet = { warn() {}, error() {}, info() {} };
const doc = (lang, slug, title, sections) => {
  fs.mkdirSync(path.join(root, lang), { recursive: true });
  fs.writeFileSync(path.join(root, lang, `${slug}.md`),
    `---\ntitle: ${title}\ntopic: t\nupdated: 2026-10-27\n---\n\n${sections.map(([h, t]) => `## ${h}\n${t}\n`).join('\n')}`);
};

before(async () => {
  db = await createTestDb();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-'));
  doc('ru', 'handover-date', 'Сроки сдачи', [['Когда сдача дома', 'Дом сдаётся в четвёртом квартале 2027 года. Срок ориентировочный.'],
    ['Что после сдачи', 'После сдачи дома идёт приёмка квартир, приёмка занимает шестьдесят дней.']]);
  doc('ru', 'parking', 'Паркинг', [['Подземный паркинг', 'Под домом есть подземный паркинг. Места продаются отдельно от квартир.']]);
  await ingest({ db, ai: fakeEmbedAi(), root, log: quiet, sleep: async () => {} });
  kb = createKb({ db, ai: fakeEmbedAi(), env: ENV, log: quiet });
  tools = createTools({ db, env: ENV, kb, log: quiet });
});
after(() => db.close());
beforeEach(() => fakeClock.set('2026-10-28T10:00:00+05:00'));
afterEach(() => fakeClock.reset());

// the base keeps the knowledge base between tests, so only the model accounting is cleared (15 requests a minute guard of 06 §7)
async function setup(script) {
  await db.exec('DELETE FROM ai_calls; DELETE FROM ai_provider_state;');
  const gemini = fakeProvider('gemini', { 'gemini-3.8-flash': script, 'gemini-3.5-flash-lite': [{ text: JSON.stringify({ lang: 'ru', agents: ['kb_consultant'],
    tasks: {}, handoff: false, injection: false }) }] });
  const ai = createAi({ db, adapters: { gemini, anthropic: null }, env: ENV, log: quiet });
  const c = await makeClient(db, { name: 'Аня', phone: '+998901234567', channel: 'telegram' });
  const conv = await db.one(`INSERT INTO conversations (kind, client_id, channel, lang, created_at, updated_at)
    VALUES ('client', $1, 'telegram', 'ru', $2, $2) RETURNING id`, [c.id, new Date('2026-10-28T05:00:00Z')]);
  const toolCtx = { actor: asClient(c, 'telegram'), source: 'agent', lang: 'ru', conversationId: conv.id, turnId: '00000000-0000-4000-8000-000000000003' };
  const events = [];
  const go = message => runAgent({ ai, tools, agent: 'kb_consultant', message, context: '[context]\nlanguage: ru\n[/context]', lang: 'ru',
    toolCtx, onEvent: e => events.push(e) });
  return { gemini, go, events, ai, c, conv };
}
const SEARCH = { calls: [{ name: 'search_kb', args: { query: 'Когда сдача дома, какой срок сдачи?' } }] };

test('07 §5.4: the model sees only search_kb; the fragments come back with numbers (no scores, no ids)', async () => {
  const { gemini, go } = await setup([SEARCH, { text: 'Сдача в четвёртом квартале 2027 года [1].' }]);
  await go('Когда сдача?');
  assert.deepEqual(gemini.calls[0].req.tools.map(t => t.name), ['search_kb']);
  const back = gemini.calls[1].req.messages.at(-1).parts[0].result;
  assert.equal(back.answered, true);
  assert.deepEqual(Object.keys(back.fragments[0]), ['n', 'heading', 'text']);
});

test('09 §6: an answer with [1] → citations of the mentioned fragments; the search is logged in kb_queries', async () => {
  const { go } = await setup([SEARCH, { text: 'Сдача в четвёртом квартале 2027 года [1].' }]);
  const r = await go('Когда сдача?');
  assert.equal(r.ok, true);
  assert.equal(r.error, null);
  assert.deepEqual(r.citations.map(c => [c.n, c.doc]), [[1, 'handover-date']]);
  assert.equal((await db.query('SELECT 1 FROM kb_queries WHERE answered')).length >= 1, true);
});

test('09 §6: a number the tool never gave is cut out of the text (and the text is re-sent)', async () => {
  const { go, events } = await setup([SEARCH, { text: 'Сдача в 2027 году [1], приёмка 60 дней [9].' }]);
  const r = await go('Когда сдача?');
  assert.equal(r.text, 'Сдача в 2027 году [1], приёмка 60 дней.');
  assert.deepEqual(r.citations.map(c => c.n), [1]);
  assert.ok(events.some(e => e.type === 'reset'));
});

test('09 §6: no citation → one more try «Cite sources as [n]»; still none → the answer goes, error no_citations', async () => {
  const a = await setup([SEARCH, { text: 'Сдача в 2027 году.' }, { text: 'Сдача в 2027 году [1].' }]);
  const r1 = await a.go('Когда сдача?');
  assert.equal(r1.error, null);
  assert.equal(r1.citations.length, 1);
  assert.match(a.gemini.calls[2].req.messages.at(-1).parts[0].text, /Cite sources as \[n\]/);

  const b = await setup([SEARCH, { text: 'Сдача в 2027 году.' }, { text: 'Сдача в 2027 году.' }]);
  const r2 = await b.go('Когда сдача?');
  assert.equal(r2.error, 'no_citations');
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.citations, []);
});

test('FR-KB-03: nothing in the base → the honest refusal comes from the code, whatever the model wrote', async () => {
  const { go } = await setup([{ calls: [{ name: 'search_kb', args: { query: 'Какой вид из окна у квартиры сорок один?' } }] },
    { text: 'Вид из окна прекрасный, окна выходят на парк [1].' }]);
  const r = await go('Какой вид из окна у 41?');
  assert.equal(r.text, 'В базе знаний ЖК нет ответа на этот вопрос.');
  assert.equal(r.error, 'no_kb_answer');
  assert.equal(r.kb.answered, false);
  assert.equal((await db.query('SELECT 1 FROM kb_queries WHERE NOT answered')).length >= 1, true);
});

test('07 §5.4: an answer without the search is sent back once («Call search_kb first»)', async () => {
  const { gemini, go } = await setup([{ text: 'Сдача завтра.' }, SEARCH, { text: 'Сдача в 2027 году [1].' }]);
  const r = await go('Когда сдача?');
  assert.match(gemini.calls[1].req.messages.at(-1).parts[0].text, /Call search_kb first/);
  assert.equal(r.citations.length, 1);
  assert.equal(r.ok, true);
});

test('11 §: the turn — status «Ищу в базе знаний», a citations block, the buttons: neighbour topics and «Спросить менеджера»', async () => {
  const s = await setup([SEARCH, { text: 'Сдача в четвёртом квартале 2027 года [1].' }]);
  const turns = createTurns({ db, ai: s.ai, tools, env: ENV, log: quiet });
  const events = [];
  const res = await turns.runTurn({ conversationId: s.conv.id, actor: asClient(s.c, 'telegram'), text: 'Когда сдача дома?', channel: 'telegram',
    sink: e => events.push(e) });
  assert.match(events.find(e => e.type === 'status').data.text, /базе знаний/);
  const block = res.blocks.find(b => b.type === 'citations');
  assert.deepEqual(block.data.items.map(c => c.n), [1]);
  assert.ok(res.suggestions.some(x => x.intent === 'call_manager'));
  assert.ok(res.suggestions.length <= 3);
  assert.match(res.text, /\[1\]/);
});

test('11 §: the turn with no answer in the base → the refusal text and the manager button, no citations', async () => {
  const s = await setup([{ calls: [{ name: 'search_kb', args: { query: 'Какой вид из окна у квартиры сорок один?' } }] }, { text: 'Красивый.' }]);
  const turns = createTurns({ db, ai: s.ai, tools, env: ENV, log: quiet });
  const res = await turns.runTurn({ conversationId: s.conv.id, actor: asClient(s.c, 'telegram'), text: 'Какой вид из окна?', channel: 'telegram', sink: () => {} });
  assert.equal(res.text, 'В базе знаний ЖК нет ответа на этот вопрос.');
  assert.equal(res.blocks.some(b => b.type === 'citations'), false);
  assert.ok(res.suggestions.some(x => x.intent === 'call_manager'));
});
