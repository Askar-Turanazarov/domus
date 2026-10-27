// 07 §4–5 the sub-agent loop on a fake model and the real tools: the agent's own tools only, parallel reads, one action
// per turn (a draft, nothing executed), the step limit, refusal, max_tokens, no model; the context and the digest.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock } from '../../server/core/clock.js';
import { createAi } from '../../server/ai/index.js';
import { createTools } from '../../server/tools/registry.js';
import { runAgent, smalltalk } from '../../server/agents/agent.js';
import { contextBlock, memoryLine, digestOf } from '../../server/agents/context.js';
import { prompt } from '../../server/agents/prompts.js';
import { fakeProvider } from '../ai/fakes.js';
import { createTestDb, resetDb } from '../support/db.js';
import { makeClient, asClient } from '../support/factories.js';

let db, tools;
const ENV = { TELEGRAM_STAFF_CHAT_ID: '-1', LINK_SECRET: 'test-secret', PUBLIC_URL: 'https://x.test', GEMINI_API_KEY: 'x' };
const quiet = { warn() {}, error() {} };
before(async () => { db = await createTestDb(); tools = createTools({ db, env: ENV }); });
after(() => db.close());
beforeEach(async () => { await resetDb(db); fakeClock.set('2026-10-28T10:00:00+05:00'); });
afterEach(() => fakeClock.reset());

async function setup(script, { gemini36 = null } = {}) {
  const gemini = fakeProvider('gemini', { 'gemini-3.8-flash': script, ...(gemini36 ? { 'gemini-3.6-flash': gemini36 } : {}) });
  const ai = createAi({ db, adapters: { gemini, anthropic: null }, env: ENV, log: quiet });
  const c = await makeClient(db, { name: 'Аня', phone: '+998901234567', channel: 'telegram' });
  const conv = await db.one(`INSERT INTO conversations (kind, client_id, channel, lang, created_at, updated_at)
    VALUES ('client', $1, 'telegram', 'ru', $2, $2) RETURNING id`, [c.id, new Date('2026-10-28T05:00:00Z')]);
  const toolCtx = { actor: asClient(c, 'telegram'), source: 'agent', lang: 'ru', conversationId: conv.id,
    turnId: '00000000-0000-4000-8000-000000000002' };
  const events = [];
  const go = (agent, message, extra = {}) => runAgent({ ai, tools, agent, message, context: '[context]\nlanguage: ru\n[/context]', lang: 'ru',
    toolCtx, onEvent: e => events.push(e), ...extra });
  return { gemini, go, events, toolCtx };
}

test('apt_finder: only its tools reach the model; the system part is _common + the agent; context first, task after the message', async () => {
  const { gemini, go } = await setup([{ text: 'Подберу.' }]);
  await go('apt_finder', 'Трёшка до миллиарда', { task: '3 rooms ≤ 1 000 000 000' });
  const req = gemini.calls[0].req;
  assert.deepEqual(req.tools.map(t => t.name), ['search_apartments', 'get_apartment']);
  assert.equal(req.tools[0].schema.additionalProperties, false);
  assert.equal(req.system, prompt('apt_finder').text);
  assert.match(req.system, /^You are an AI sales consultant[\s\S]*Your job: choose apartments/);
  assert.equal(req.messages[0].parts[0].text, '[context]\nlanguage: ru\n[/context]');
  assert.equal(req.messages.at(-1).parts[0].text, 'Трёшка до миллиарда\n\n[task] 3 rooms ≤ 1 000 000 000');
});

test('reading calls of a step run together; results go back as tool results; a foreign tool → unknown_tool', async () => {
  const { gemini, go } = await setup([{ calls: [{ name: 'get_apartment', args: { no: 41 } }, { name: 'get_apartment', args: { no: 42 } },
    { name: 'create_booking', args: { apartmentNo: 41 } }] }, { text: 'Готово.' }]);
  const r = await go('apt_finder', 'Сравни 41 и 42');
  assert.deepEqual(r.calls.map(c => [c.name, c.ok, c.error]), [['get_apartment', true, null], ['get_apartment', true, null],
    ['create_booking', false, 'unknown_tool']]);
  const back = gemini.calls[1].req.messages.at(-1);
  assert.equal(back.role, 'tool');
  assert.deepEqual(back.parts.map(p => [p.id, p.name, p.isError]), [['tc_1', 'get_apartment', false], ['tc_2', 'get_apartment', false],
    ['tc_3', 'create_booking', true]]);
  assert.equal(back.parts[0].result.price, 1024500000);
  assert.equal((await db.query('SELECT 1 FROM pending_actions')).length, 0);
});

test('booking: create_booking → a draft (the model sees only «pending»), a second action of the turn → one_action_per_turn', async () => {
  const { gemini, go, toolCtx } = await setup([{ calls: [{ name: 'create_booking', args: { apartmentNo: 41 } },
    { name: 'book_viewing', args: { no: 41, datetime: '2026-10-30T15:00' } }] }, { text: 'Проверьте условия и нажмите «Да».' }]);
  const turn = { pending: [] };
  const r = await go('booking', 'Забронируй №41 и запиши на показ', { turn });
  assert.equal(r.pending.length, 1);
  assert.equal(r.pending[0].tool, 'create_booking');
  assert.deepEqual(turn.pending, [r.pending[0].pendingActionId]);
  assert.deepEqual(r.calls.map(c => c.error), [null, 'one_action_per_turn']);
  const back = gemini.calls[1].req.messages.at(-1).parts;
  assert.deepEqual(Object.keys(back[0].result), ['pending', 'summary'], 'no terms, no link for the model');
  assert.equal((await db.query('SELECT 1 FROM bookings')).length, 0, 'nothing executed');
  assert.equal((await tools.pendingOf(toolCtx.conversationId)).length, 1);
  // the next agent of the same turn cannot make a second action either
  const again = await setup([{ calls: [{ name: 'book_viewing', args: { no: 41, datetime: '2026-10-30T15:00' } }] }, { text: 'ok' }]);
  const r2 = await again.go('booking', 'И показ', { turn });
  assert.equal(r2.calls[0].error, 'one_action_per_turn');
});

test('the step limit → max_steps template; refusal → refusal template; no model → unavailable with no text', async () => {
  const loop = await setup([{ calls: [{ name: 'search_apartments', args: { rooms: 3 } }] }]);
  const m = await loop.go('apt_finder', 'ищи');
  assert.deepEqual([m.ok, m.error, m.steps, m.text], [false, 'max_steps', 3, 'Не успел досчитать — уточните, пожалуйста, вопрос.']);
  const refuse = await setup([{ stop: 'refusal' }]);
  const f = await refuse.go('finance', '...');
  assert.deepEqual([f.ok, f.error], [false, 'refusal']);
  assert.match(f.text, /^С этим я помочь не могу/);
  const down = await setup([{ error: 'server', early: true }], { gemini36: [{ error: 'server', early: true }] });
  const d = await down.go('apt_finder', 'ищи');
  assert.deepEqual([d.ok, d.error, d.text, d.provider], [false, 'unavailable', '', 'scripted']);
});

test('max_tokens → one repeat with «Answer shorter.»; the counts summed; the next step starts on the model that answered', async () => {
  const { gemini, go, events } = await setup([{ error: 'server', early: true }],
    { gemini36: [{ text: 'Очень длинно…', stop: 'max_tokens', usage: { input: 100, output: 10, cached: 0 } },
      { text: 'Коротко.', usage: { input: 120, output: 5, cached: 20 } }] });
  const turn = { pending: [] };
  const r = await go('apt_finder', 'расскажи', { turn });
  assert.equal(r.text, 'Коротко.');
  assert.equal(gemini.calls.at(-1).req.messages.at(-1).parts[0].text, 'Answer shorter.');
  assert.deepEqual(r.usage, { input: 220, output: 15, cached: 20 });
  assert.deepEqual([r.model, r.fallback, turn.from], ['gemini-3.6-flash', true, 'gemini-3.6-flash']);
  assert.deepEqual(events.map(e => e.type), ['text', 'reset', 'text']);
  assert.ok(events.every(e => e.agent === 'apt_finder'));
});

test('07 §7.3, §6.1, §4.2: the context block, the memory line and the digest of the first agent', () => {
  const state = { filters: { rooms: 3, priceMax: 1000000000, floorMin: 5 }, shown: [41, 57, 63], focusApartment: 41 };
  assert.equal(memoryLine(state), '3 rooms, ≤ 1 000 000 000 UZS, floor ≥ 5; shown 41, 57, 63; focus 41');
  assert.equal(memoryLine({}), null);
  const block = contextBlock({ now: '2026-11-02T04:00:00Z', channel: 'telegram', lang: 'uz', state,
    client: { known: true, phone: 'yes(verified)', holds: [{ apartmentNo: 41, until: '2026-11-02T09:32:00Z' }] },
    digest: 'apt_finder → 41 (980 000 000)' });
  assert.equal(block, ['[context]', 'today: 2026-11-02 (Asia/Tashkent)', 'channel: telegram', 'language: uz',
    'client: known=yes, phone=yes(verified), active_holds=1 (№41, until 14:32)',
    'memory: 3 rooms, ≤ 1 000 000 000 UZS, floor ≥ 5; shown 41, 57, 63; focus 41',
    'previous_agent_digest: apt_finder → 41 (980 000 000)', '[/context]'].join('\n'));
  const d = digestOf({ agent: 'apt_finder', text: 'Нашёл две.\nПервая…', calls: [{ ok: true, result: { items: [
    { no: 41, price: 980000000 }, { no: 57, price: 1000000000 }] } }] });
  assert.equal(d, 'apt_finder → 41 (980 000 000), 57 (1 000 000 000); said: «Нашёл две.»');
});

test('07 §5.5 smalltalk: templates without a model', () => {
  assert.match(smalltalk('hello', 'ru').text, /^Здравствуйте! Я ИИ-консультант/);
  assert.equal(smalltalk('thanks', 'en').provider, 'scripted');
  assert.match(smalltalk('bot', 'ru').text, /Могу позвать менеджера/);
});
