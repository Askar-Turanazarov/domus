// 07 §15.4 agents/grounding: the figures of a text against the turn's tool calls; an invented price is replaced after one
// repeat, a real one passes; the masks of §15.1.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock } from '../../server/core/clock.js';
import { createAi } from '../../server/ai/index.js';
import { createTools } from '../../server/tools/registry.js';
import { CLIENT_TOOLS } from '../../server/tools/client.js';
import { runAgent } from '../../server/agents/agent.js';
import { figuresIn, knownNumbers, ungrounded, scrub } from '../../server/agents/grounding.js';
import { mask, forStorage } from '../../server/agents/pii.js';
import { fakeProvider } from '../ai/fakes.js';
import { createTestDb, resetDb } from '../support/db.js';
import { makeClient, asClient } from '../support/factories.js';

const nb = s => s.replaceAll(String.fromCharCode(160), ' ');

test('figures: sums with spaces, dots, commas, «млн» / «млрд» with their rounding; apartment numbers in three languages', () => {
  const f = figuresIn('№41 — 1 024 500 000 сум (≈1,02 млрд), 41-xonadon, Apt. 57, 980 млн, 1,024,500,000 UZS, 12 месяцев, 30%');
  assert.deepEqual(f.map(x => [x.kind, x.value]), [['sum', 1024500000], ['sum', 1020000000], ['sum', 980000000], ['sum', 1024500000],
    ['apt', 41], ['apt', 41], ['apt', 57]]);
  assert.equal(f[1].tol, 5_000_000, 'two decimals of a billion');
});

test('known: the numbers of tool args and results and of the client message; invented ones are flagged and scrubbed', () => {
  const known = knownNumbers({ calls: [{ args: { no: 41 }, result: { no: 41, price: 1024500000, items: [{ no: 57, price: 990200000 }] } }],
    message: 'до 1 млрд' });
  assert.deepEqual(ungrounded('№41 за 1 024 500 000 сум, №57 за 990 млн, в бюджете до 1 000 000 000', known), []);
  const miss = ungrounded('№41 за 1 024 500 000 сум, а №63 — всего 850 млн', known);
  assert.deepEqual(miss.map(m => m.text), ['850 млн', '№63']);
  assert.equal(scrub('№63 — всего 850 млн', miss, '(уточните у менеджера)'), '(уточните у менеджера) — всего (уточните у менеджера)');
});

test('07 §15.1: phones of Uzbek and international forms → the mark, the number kept; card numbers → the mark; sums stay', () => {
  assert.deepEqual(mask('Мой номер +998 90 123-45-67, звоните'), { text: 'Мой номер [телефон], звоните', phones: ['+998901234567'], card: false });
  assert.deepEqual(mask('telefonim 90 123 45 67', 'uz').text, 'telefonim [telefon]');
  assert.deepEqual(mask('call +44 20 7946 0958', 'en').phones, ['+442079460958']);
  assert.deepEqual(mask('Карта 8600 1234 5678 9012, срок 12/27'), { text: 'Карта [номер карты], срок 12/27', phones: [], card: true });
  for (const s of ['бюджет 1 000 000 000 сум', 'до 980000000 сум', 'Квартира №41, 3 комнаты']) assert.equal(mask(s).text, s);
  assert.equal(forStorage('карта 8600123456789012 и +998901234567'), 'карта [номер карты] и +998901234567', 'the phone is stored');
});

let db, tools;
const ENV = { TELEGRAM_STAFF_CHAT_ID: '-1', LINK_SECRET: 'test-secret', PUBLIC_URL: 'https://x.test', GEMINI_API_KEY: 'x' };
before(async () => { db = await createTestDb(); tools = createTools({ db, env: ENV, tools: CLIENT_TOOLS }); });
after(() => db.close());
beforeEach(async () => { await resetDb(db); fakeClock.set('2026-10-28T10:00:00+05:00'); });
afterEach(() => fakeClock.reset());

async function agentRun(script, message = 'Сколько стоит №41?') {
  const gemini = fakeProvider('gemini', { 'gemini-3.8-flash': script });
  const ai = createAi({ db, adapters: { gemini, anthropic: null }, env: ENV, log: { warn() {}, error() {} } });
  const c = await makeClient(db, { channel: 'telegram' });
  const events = [];
  const r = await runAgent({ ai, tools, agent: 'apt_finder', message, context: '[context]\n[/context]', lang: 'ru',
    toolCtx: { actor: asClient(c, 'telegram'), source: 'agent', lang: 'ru', turnId: '00000000-0000-4000-8000-000000000001' },
    onEvent: e => events.push(e) });
  return { r, events, gemini };
}

test('a real price passes the check', async () => {
  const { r, gemini } = await agentRun([{ calls: [{ name: 'get_apartment', args: { no: 41 } }] }, { text: '№41 стоит 1 024 500 000 сум.' }]);
  assert.deepEqual([r.ok, r.error, r.text, r.steps], [true, null, '№41 стоит 1 024 500 000 сум.', 2]);
  assert.equal(gemini.calls.length, 2);
});

test('an invented price: one repeat with the note; still invented → replaced, ungrounded_number; the stream is reset', async () => {
  const { r, events, gemini } = await agentRun([{ calls: [{ name: 'get_apartment', args: { no: 41 } }] },
    { text: '№41 стоит 900 000 000 сум.' }, { text: '№41 стоит 900 млн.' }]);
  const note = gemini.calls[2].req.messages.at(-1).parts[0].text;
  assert.equal(note, 'Number 900 000 000 is not in tool results. Use only tool results.');
  assert.deepEqual([r.ok, r.error, nb(r.text)], [true, 'ungrounded_number', '№41 стоит (уточните у менеджера).']);
  assert.deepEqual(events.map(e => e.type), ['text', 'reset', 'text', 'reset', 'text']);
});

test('an invented price corrected on the repeat → the correct text, no error', async () => {
  const { r } = await agentRun([{ calls: [{ name: 'get_apartment', args: { no: 41 } }] },
    { text: '№41 стоит 900 000 000 сум.' }, { text: '№41 стоит 1 024 500 000 сум.' }]);
  assert.deepEqual([r.error, r.text], [null, '№41 стоит 1 024 500 000 сум.']);
});
