// 07 §14, 12 §11, 13 §9 (D5-03): the head's read-only analyst — its own prompt and only the six reading reports, an answer from a
// tool result with the table built by code, no way to change anything, POST /api/admin/analyst as SSE for the head only.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { fakeClock } from '../../server/core/clock.js';
import { hashPassword } from '../../server/adminAuth.js';
import { createStaff } from '../../server/core/staff.js';
import { createAi } from '../../server/ai/index.js';
import { createTools } from '../../server/tools/registry.js';
import { createTurns } from '../../server/agents/turn.js';
import { AGENTS } from '../../server/agents/agent.js';
import { analystTable } from '../../server/agents/analystTable.js';
import { mountAdmin } from '../../server/http/admin.js';
import { mountAdminAnalyst } from '../../server/http/adminAnalyst.js';
import { requestId, apiErrors } from '../../server/http/common.js';
import { parseSse } from '../../public/js/chat/stream.js';
import { fakeProvider } from '../ai/fakes.js';
import { createTestDb, resetDb } from '../support/db.js';
import { makeClient, makeBooking, asStaff } from '../support/factories.js';

const ENV = { LINK_SECRET: 'test-secret', SESSION_SECRET: 'x'.repeat(40), LOG_SALT: 'salt', PUBLIC_URL: 'https://x.test', GEMINI_API_KEY: 'x' };
const PASSWORD = 'analyst test password 1';
const READING = ['sales_summary', 'funnel', 'list_bookings', 'list_payments', 'list_viewings', 'ai_activity'];
const quiet = { warn() {}, error() {} };
let db, tools, server, base, g;
// the model of each test: a fresh fake behind one adapter (the AI layer keeps the adapter)
const model = steps => { g = fakeProvider('gemini', { 'gemini-3.8-flash': steps }); };

before(async () => {
  db = await createTestDb();
  tools = createTools({ db, env: ENV });
  model([]);
  const adapter = { provider: 'gemini', call: (req, o) => g.call(req, o) };
  const ai = createAi({ db, adapters: { gemini: adapter, anthropic: null }, env: ENV, log: quiet });
  const turns = createTurns({ db, ai, tools, env: ENV, log: quiet });
  const app = express();
  app.use(requestId);
  const staffAuth = mountAdmin(app, db, { env: ENV, cacheMs: 0 });
  mountAdminAnalyst(app, db, staffAuth, { turns }, { env: ENV });
  app.use(apiErrors);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  test.turns = turns;
});
after(() => { server.close(); return db.close(); });

let staff, cookies;
beforeEach(async () => {
  await resetDb(db);
  fakeClock.set('2026-10-28T10:00:00+05:00');
  const passwordHash = await hashPassword(PASSWORD);
  staff = {}; cookies = {};
  for (const role of ['manager', 'head']) {
    staff[role] = await createStaff(db, { login: 'a-' + role, name: role, role, passwordHash });
    const res = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'domus-admin' },
      body: JSON.stringify({ login: 'a-' + role, password: PASSWORD }) });
    cookies[role] = res.headers.get('set-cookie').split(';')[0];
  }
});
afterEach(() => fakeClock.reset());

async function burned() {
  const c = await makeClient(db, { name: 'Дилноза Рахимова', phone: '+998901234567' });
  for (const no of [41, 42]) await makeBooking(db, { apartmentNo: no, clientId: c.id, status: 'expired', minutes: -60 });
  await makeBooking(db, { apartmentNo: 43, clientId: c.id, status: 'booked', minutes: 24 * 60 });
}
const conversation = async (staffId, kind = 'analyst') => db.one(`INSERT INTO conversations (kind, staff_id, channel, lang, created_at, updated_at)
  VALUES ($1, $2, 'admin', 'ru', $3, $3) RETURNING *`, [kind, staffId, new Date('2026-10-28T05:00:00Z')]);
const post = (role, body) => fetch(base + '/api/admin/analyst', { method: 'POST', body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'domus-admin', Cookie: cookies[role] } });

test('the analyst sees only the six reading reports; a manager none; extend and cancel are never offered', () => {
  assert.deepEqual(AGENTS.analyst.tools, READING);
  const offered = ctx => tools.schemas(ctx).filter(s => AGENTS.analyst.tools.includes(s.name)).map(s => s.name).sort();
  const head = { actor: { type: 'staff', id: 'x', role: 'head', channel: 'admin' }, source: 'agent' };
  assert.deepEqual(offered(head), [...READING].sort());
  assert.ok(!AGENTS.analyst.tools.some(n => tools.get(n).mutates), 'no tool of the analyst changes data');
  assert.deepEqual(offered({ ...head, actor: { ...head.actor, role: 'manager' } }), []);
  assert.ok(!tools.schemas(head).some(s => ['extend_booking', 'cancel_booking'].includes(s.name)), 'extend/cancel are MCP only');
});

test('«сколько броней сгорело за неделю?» → list_bookings status=expired, the answer from total, the table by code, own prompt', async () => {
  await burned();
  model([
    { calls: [{ name: 'list_bookings', args: { status: 'expired', from: '2026-10-22', to: '2026-10-28' } }] },
    { text: 'За неделю сгорело **2** брони.' }]);
  const head = await conversation(staff.head.id);
  const events = [];
  const r = await test.turns.runAnalyst({ conversationId: head.id, text: 'Сколько броней сгорело за неделю?', actor: asStaff(staff.head), sink: e => events.push(e) });
  assert.equal(r.text, 'За неделю сгорело **2** брони.');
  assert.deepEqual(r.tools, ['list_bookings']);
  const req = g.calls[0].req;
  assert.match(req.system, /^You are the analyst/, 'own prompt, without the client-facing common part');
  assert.deepEqual(req.tools.map(s => s.name).sort(), [...READING].sort());
  assert.match(req.messages[0].parts[0].text, /today: 2026-10-28 \(Wednesday, Asia\/Tashkent\)\nlanguage: ru/);
  assert.deepEqual(events.map(e => e.type === 'block' ? `block:${e.data.type}` : e.type).filter((k, i, a) => !(k === 'text' && a[i - 1] === 'text')),
    ['text', 'block:table', 'done']);
  const table = r.blocks[0].data;
  assert.equal(table.tool, 'list_bookings');
  assert.equal(table.total, 2);
  assert.equal(table.link, '#/bookings');
  assert.deepEqual(table.columns, ['Бронь', 'Квартира', 'Статус', 'Клиент', 'До', 'Депозит']);
  assert.deepEqual(table.rows.map(x => [x[1], x[2], x[3]]), [['№42', 'сгорела', 'Дилноза Рахимова · +998 90 *** ** 67'],
    ['№41', 'сгорела', 'Дилноза Рахимова · +998 90 *** ** 67']]);
  const msgs = await db.query('SELECT role, blocks FROM messages WHERE conversation_id = $1 ORDER BY id', [head.id]);
  assert.deepEqual(msgs.map(m => m.role), ['user', 'assistant']);
  assert.equal(msgs[1].blocks[0].type, 'table');
  const run = await db.one('SELECT agent, tools, ok FROM agent_runs WHERE turn_id = $1', [r.turnId]);
  assert.deepEqual([run.agent, run.tools, run.ok], ['analyst', ['list_bookings'], true]);
});

test('«продли бронь»: a call to extend_booking is refused as unknown, nothing changes', async () => {
  await burned();
  const b = await db.one("SELECT id, no, expires_at FROM bookings WHERE status = 'booked'");
  model([
    { calls: [{ name: 'extend_booking', args: { bookingNo: b.no, hours: 24, reason: 'просьба' } }] },
    { text: `Я только смотрю данные. Продлить можно в карточке брони №${b.no}.` }]);
  const conv = await conversation(staff.head.id);
  const r = await test.turns.runAnalyst({ conversationId: conv.id, text: `Продли бронь №${b.no} на сутки`, actor: asStaff(staff.head) });
  assert.match(r.text, /только смотрю/);
  assert.deepEqual(r.blocks, [], 'no table without a reading report');
  const after = await db.one('SELECT expires_at, extended_count FROM bookings WHERE id = $1', [b.id]);
  assert.deepEqual([after.expires_at.getTime(), after.extended_count], [new Date(b.expires_at).getTime(), 0]);
  assert.equal((await db.one("SELECT count(*)::int AS n FROM events WHERE type = 'booking_extended'")).n, 0);
});

test('the table of a report: «what — how much» rows; ai_activity opens #/ai', () => {
  const ai = analystTable({ calls: [{ name: 'ai_activity', ok: true, result: { from: '2026-10-22', to: '2026-10-28', turns: 12, toolCalls: 30,
    errors: 1, fallbacks: 0, up: 3, down: 1, unanswered: 2, costUsd: 0.4567, byModel: [{ model: 'gemini-3.8-flash', calls: 20, costUsd: 0.4 }] } }] }, 'en');
  assert.deepEqual(ai.data.columns, ['Metric', 'Value']);
  assert.deepEqual(ai.data.rows.find(r => r[0] === 'AI cost'), ['AI cost', '$0.46']);
  assert.deepEqual(ai.data.rows.at(-1), ['', 'gemini-3.8-flash: 20 · $0.40']);
  assert.equal(ai.data.link, '#/ai');
  assert.equal(analystTable({ calls: [{ name: 'funnel', ok: false, result: null }] }, 'ru'), null);
  // «сравни эту и прошлую неделю»: two sales_summary calls → one column per period
  const week = (from, to, n) => ({ name: 'sales_summary', ok: true, result: { from, to, deposits: { count: n, sum: n * 1e7 }, holds: n + 1, bookings: n,
    sales: { count: 0, sum: 0 }, conversion: { holdToBooking: n / (n + 1), bookingToSale: null } } });
  const cmp = analystTable({ calls: [week('2026-10-26', '2026-10-28', 2), week('2026-10-19', '2026-10-25', 5)] }, 'ru');
  assert.deepEqual(cmp.data.columns, ['Показатель', '2026-10-26 — 2026-10-28', '2026-10-19 — 2026-10-25']);
  assert.deepEqual(cmp.data.rows[2], ['Брони оплачены', '2', '5']);
});

test('POST /api/admin/analyst: a manager 403; the head gets the SSE stream and a new dialog; a foreign dialog 404', async () => {
  assert.equal((await post('manager', { text: 'привет' })).status, 403);
  await burned();
  model([{ calls: [{ name: 'list_bookings', args: { status: 'expired' } }] }, { text: 'Сгорело **2**.' }]);
  const res = await post('head', { text: 'Сколько сгорело?' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/event-stream/);
  const events = [...parseSse(await res.text())];
  assert.deepEqual([...new Set(events.map(e => e.event))], ['meta', 'status', 'text', 'block', 'done']);
  const id = events[0].data.conversationId;
  const conv = await db.one('SELECT kind, staff_id, channel FROM conversations WHERE id = $1', [id]);
  assert.deepEqual(conv, { kind: 'analyst', staff_id: staff.head.id, channel: 'admin' });
  assert.equal(events.find(e => e.event === 'block').data.data.total, 2);

  const foreign = await conversation(staff.manager.id);
  const miss = await post('head', { conversationId: foreign.id, text: 'ещё' });
  assert.equal(miss.status, 404);
  assert.equal((await miss.json()).error, 'conversation_not_found');
  assert.equal((await post('head', { text: '' })).status, 400);
});
