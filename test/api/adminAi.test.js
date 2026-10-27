// 12 §8, 13 §9.8, 07 §16.2, 08 §9, 06 §14, 09 §8: the AI journals over HTTP with the real staff gate — the list of turns with filters and a
// cursor, a manager sees only the turns of their own clients, the tree of one turn, the journal of tools, the costs by day with today's
// budget, the chunks of the knowledge base, «without an answer» grouped, the reindex (head only, off without a key).
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { fakeClock, now } from '../../server/core/clock.js';
import { hashPassword } from '../../server/adminAuth.js';
import { createStaff } from '../../server/core/staff.js';
import { mountAdmin } from '../../server/http/admin.js';
import { mountAdminAi } from '../../server/http/adminAi.js';
import { requestId, apiErrors } from '../../server/http/common.js';
import { createTestDb, resetDb } from '../support/db.js';
import { makeClient } from '../support/factories.js';
import { fakeEmbedAi } from '../kb/support.js';

const PASSWORD = 'ai test password 1';
const ENV = { LINK_SECRET: 'test-secret', SESSION_SECRET: 'x'.repeat(40), LOG_SALT: 'salt', GEMINI_API_KEY: 'k', AI_DAILY_BUDGET_USD: '5' };
const uid = () => crypto.randomUUID();
let db, server, base, cookies, kbRoot, ai, env = ENV;

before(async () => {
  db = await createTestDb();
  kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-admin-'));
  fs.mkdirSync(path.join(kbRoot, 'ru'));
  fs.writeFileSync(path.join(kbRoot, 'ru', 'parking.md'), '---\ntitle: Паркинг\ntopic: паркинг\nupdated: 2026-10-27\n---\n\n## Места\nПодземный паркинг на 120 мест.\n\n## Цена\nМесто стоит 15 000 долларов.\n');
  ai = fakeEmbedAi();
  const app = express();
  app.use(requestId);
  const staffAuth = mountAdmin(app, db, { env: ENV, cacheMs: 0 });
  mountAdminAi(app, db, staffAuth, { env: new Proxy({}, { get: (_, k) => env[k] }), ai, kbRoot });
  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));
  app.use(apiErrors);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); return db.close(); });

let staff;
beforeEach(async () => {
  await resetDb(db);
  env = ENV;
  fakeClock.set('2026-10-28T10:00:00+05:00');
  const passwordHash = await hashPassword(PASSWORD);
  cookies = {}; staff = {};
  for (const role of ['manager', 'head']) {
    staff[role] = await createStaff(db, { login: 'u-' + role, name: role, role, passwordHash });
    const res = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'domus-admin' },
      body: JSON.stringify({ login: 'u-' + role, password: PASSWORD }) });
    assert.equal(res.status, 200);
    cookies[role] = res.headers.get('set-cookie').split(';')[0];
  }
});
afterEach(() => fakeClock.reset());

async function call(method, path, { role = 'head', body } = {}) {
  const headers = { 'X-Requested-With': 'domus-admin' };
  if (role) headers.cookie = cookies[role];
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// A turn: a conversation of the client, runs, model calls, a tool call, a user message and an answer.
async function turn({ minutesAgo = 1, clientId, agents = [['router', 'fast'], ['apt_finder', 'tools']], ms = 1200, ok = true, error = null, fallback = false, feedback = null, tool = null, cost = 0.01 } = {}) {
  const at = new Date(now().getTime() - minutesAgo * 60e3);
  const conv = await db.one(`INSERT INTO conversations (kind, client_id, channel, lang, created_at, updated_at) VALUES ('client', $1, 'web', 'ru', $2, $2) RETURNING id`, [clientId, at]);
  const turnId = uid();
  for (const [agent, role] of agents) {
    await db.query(`INSERT INTO agent_runs (turn_id, conversation_id, agent, role, provider, model, fallback, steps, tools, input_tokens, output_tokens, cost_usd, ms, first_event_ms, ok, error, created_at)
      VALUES ($1, $2, $3, $4, 'gemini', $5, $6, 1, $7, 100, 20, $8, $9, 300, $10, $11, $12)`,
    [turnId, conv.id, agent, role, role === 'fast' ? 'gemini-3.5-flash-lite' : 'gemini-3.8-flash', fallback, tool && agent === 'apt_finder' ? [tool] : [], cost, ms, ok, error, at]);
    await db.query(`INSERT INTO ai_calls (at, turn_id, agent, provider, model, kind, ok, input_tokens, output_tokens, cost_usd, ms) VALUES ($1, $2, $3, 'gemini', 'gemini-3.8-flash', 'chat', true, 100, 20, $4, 400)`, [at, turnId, agent, cost]);
  }
  if (tool) await db.query(`INSERT INTO tool_calls (at, source, tool, role, turn_id, conversation_id, args, ok, ms) VALUES ($1, 'agent', $2, 'client', $3, $4, '{"rooms":2}', true, 35)`, [at, tool, turnId, conv.id]);
  await db.query(`INSERT INTO messages (conversation_id, role, text, turn_id, created_at) VALUES ($1, 'user', 'Есть двушки?', $2, $3)`, [conv.id, turnId, at]);
  await db.query(`INSERT INTO messages (conversation_id, role, text, turn_id, feedback, created_at) VALUES ($1, 'assistant', 'Да, три варианта', $2, $3, $4)`, [conv.id, turnId, feedback, at]);
  return turnId;
}

test('every entry needs a session; tools, costs and reindex are for the head only', async () => {
  for (const p of ['/api/admin/ai/runs', '/api/admin/ai/tools', '/api/admin/ai/costs', '/api/admin/kb/chunks', '/api/admin/kb/unanswered']) {
    assert.equal((await call('GET', p, { role: null })).status, 401, p);
  }
  assert.equal((await call('POST', '/api/admin/kb/reindex', { role: null, body: {} })).status, 401);
  for (const p of ['/api/admin/ai/tools', '/api/admin/ai/costs']) assert.equal((await call('GET', p, { role: 'manager' })).status, 403, p);
  assert.equal((await call('POST', '/api/admin/kb/reindex', { role: 'manager', body: {} })).status, 403);
});

test('turns: one row per turn with the sum of its runs, newest first, filters, cursor', async () => {
  const c = await makeClient(db, { name: 'Дилноза', phone: '+998901234567' });
  const good = await turn({ minutesAgo: 10, clientId: c.id, tool: 'search_apartments' });
  const bad = await turn({ minutesAgo: 8, clientId: c.id, ok: false, error: 'max_steps' });
  const reserve = await turn({ minutesAgo: 6, clientId: c.id, fallback: true });
  const down = await turn({ minutesAgo: 4, clientId: c.id, feedback: -1 });
  const slow = await turn({ minutesAgo: 2, clientId: c.id, ms: 5000 });                       // two runs of 5 s = 10 s

  const all = (await call('GET', '/api/admin/ai/runs')).body;
  assert.deepEqual(all.items.map(i => i.turnId), [slow, down, reserve, bad, good]);
  const g = all.items[4];
  assert.deepEqual(g.agents, ['router', 'apt_finder']);
  assert.deepEqual(g.tools, ['search_apartments']);
  assert.equal(g.client.name, 'Дилноза');
  assert.equal(g.tokens.input, 200);
  assert.equal(g.ms, 2400);
  assert.equal(g.channel, 'web');
  assert.equal(g.problem, false);
  assert.ok(!JSON.stringify(all).includes('998901234567'));

  const ids = async q => (await call('GET', '/api/admin/ai/runs?' + q)).body.items.map(i => i.turnId);
  assert.deepEqual(await ids('errors=1'), [bad]);
  assert.deepEqual(await ids('fallback=1'), [reserve]);
  assert.deepEqual(await ids('negative=1'), [down]);
  assert.deepEqual(await ids('problem=1'), [slow, down, reserve, bad]);

  const first = (await call('GET', '/api/admin/ai/runs?limit=2')).body;
  assert.equal(first.items.length, 2);
  const second = (await call('GET', `/api/admin/ai/runs?limit=3&cursor=${encodeURIComponent(first.next)}`)).body;
  assert.deepEqual([...first.items, ...second.items].map(i => i.turnId), [slow, down, reserve, bad, good]);
  assert.equal(second.next, null);
  assert.equal((await call('GET', '/api/admin/ai/runs?cursor=zzz')).status, 400);
});

test('a manager sees only the turns of their own clients, in the list and in the tree', async () => {
  const mine = await makeClient(db, { name: 'Мой', phone: '+998901111111' });
  const other = await makeClient(db, { name: 'Чужой', phone: '+998902222222' });
  await db.query('UPDATE clients SET assigned_staff_id = $2 WHERE id = $1', [mine.id, staff.manager.id]);
  const a = await turn({ clientId: mine.id });
  const b = await turn({ clientId: other.id, minutesAgo: 2 });

  assert.deepEqual((await call('GET', '/api/admin/ai/runs', { role: 'manager' })).body.items.map(i => i.turnId), [a]);
  assert.equal((await call('GET', `/api/admin/ai/runs/${a}`, { role: 'manager' })).status, 200);
  assert.equal((await call('GET', `/api/admin/ai/runs/${b}`, { role: 'manager' })).status, 404);
  assert.equal((await call('GET', `/api/admin/ai/runs/${b}`, { role: 'head' })).status, 200);
});

test('the tree of a turn: runs in order with model calls and tools, the dialogue, no prompts', async () => {
  const c = await makeClient(db, { name: 'Дилноза' });
  const id = await turn({ clientId: c.id, tool: 'search_apartments' });
  const tree = (await call('GET', `/api/admin/ai/runs/${id}`)).body;
  assert.deepEqual(tree.steps.map(s => s.agent), ['router', 'apt_finder']);
  assert.equal(tree.steps[1].calls.length, 1);
  assert.equal(tree.steps[1].calls[0].model, 'gemini-3.8-flash');
  assert.deepEqual(tree.steps[1].tools.map(t => [t.tool, t.args, t.ok]), [['search_apartments', { rooms: 2 }, true]]);
  assert.deepEqual(tree.steps[0].tools, []);
  assert.deepEqual(tree.messages.map(m => m.role), ['user', 'assistant']);
  assert.equal(tree.conversation.client.name, 'Дилноза');
  assert.equal((await call('GET', '/api/admin/ai/runs/not-a-uuid')).status, 404);
  assert.equal((await call('GET', `/api/admin/ai/runs/${uid()}`)).status, 404);
});

test('tools: the head sees agent and MCP calls, filters by source, tool and result', async () => {
  const c = await makeClient(db);
  await turn({ clientId: c.id, tool: 'search_apartments' });
  await db.query(`INSERT INTO tool_calls (at, source, tool, role, args, ok, ms) VALUES ($1, 'mcp', 'sales_summary', 'head', '{}', true, 12)`, [now()]);
  await db.query(`INSERT INTO tool_calls (at, source, tool, role, ok, error, ms, ip_hash) VALUES ($1, 'mcp', NULL, NULL, false, 'unauthorized', 1, 'abc123')`, [now()]);

  const list = async q => (await call('GET', '/api/admin/ai/tools' + q)).body.items;
  assert.equal((await list('')).length, 3);
  assert.deepEqual((await list('?source=mcp')).map(i => i.tool), [null, 'sales_summary']);
  assert.deepEqual((await list('?source=mcp:head')).map(i => i.tool), ['sales_summary']);
  assert.deepEqual((await list('?source=agent:apt_finder')).map(i => i.tool), ['search_apartments']);
  assert.deepEqual((await list('?ok=0')).map(i => i.error), ['unauthorized']);
  assert.deepEqual((await list('?tool=search_apartments')).map(i => i.agent), ['apt_finder']);
  assert.equal((await call('GET', '/api/admin/ai/tools?source=weird')).status, 400);
  assert.equal((await call('GET', '/api/admin/ai/tools?tool=a%20b')).status, 400);
});

test('costs: by Tashkent day and model, the paid budget of today, Gemini requests against the daily limit', async () => {
  const c = await makeClient(db);
  await turn({ clientId: c.id, cost: 0.02, fallback: true });
  await turn({ clientId: c.id, minutesAgo: 24 * 60 + 5, cost: 0.03 });
  await db.query(`INSERT INTO ai_calls (at, provider, model, kind, ok, input_tokens, output_tokens, cost_usd, ms) VALUES ($1, 'anthropic', 'claude-sonnet-5-5', 'chat', true, 1000, 100, 0.41, 900)`, [now()]);

  const r = (await call('GET', '/api/admin/ai/costs?days=7')).body;
  assert.equal(r.days.length, 2);
  assert.equal(r.days[0].day, '2026-10-28');
  assert.equal(r.days[0].calls, 3);
  assert.ok(Math.abs(r.days[0].costUsd - 0.45) < 1e-6);
  assert.deepEqual(r.days[0].byModel.map(m => m.model).sort(), ['claude-sonnet-5-5', 'gemini-3.8-flash']);
  assert.equal(r.days[0].fallbackShare, 1);
  assert.equal(r.days[1].fallbackShare, 0);
  assert.ok(Math.abs(r.today.paidUsd - 0.41) < 1e-6);
  assert.equal(r.today.budgetUsd, 5);
  const flash = r.today.gemini.find(g => g.model === 'gemini-3.8-flash');
  assert.deepEqual([flash.used, flash.limit], [2, 1500]);
  assert.equal(r.geminiTier, 'free');
  assert.equal((await call('GET', '/api/admin/ai/costs?days=1')).body.days.length, 1);
});

test('knowledge base: chunks with text and hashes, filters; the reindex fills the vectors and says what changed', async () => {
  assert.deepEqual((await call('GET', '/api/admin/kb/chunks')).body.items, []);
  const r = await call('POST', '/api/admin/kb/reindex', { body: {} });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.changed, r.body.total, r.body.deleted, r.body.documents], [2, 2, 0, 1]);
  assert.equal(r.body.partial, false);

  const chunks = (await call('GET', '/api/admin/kb/chunks', { role: 'manager' })).body;
  assert.equal(chunks.items.length, 2);
  assert.deepEqual(chunks.items.map(i => i.heading), ['Паркинг — Места', 'Паркинг — Цена']);
  assert.equal(chunks.items[0].file, 'kb/ru/parking.md');
  assert.equal(chunks.items[0].hasVector, true);
  assert.match(chunks.items[0].text, /120 мест/);
  assert.equal(chunks.items[0].hash.length, 12);
  assert.deepEqual(chunks.topics, ['паркинг']);
  assert.equal((await call('GET', '/api/admin/kb/chunks?lang=en')).body.items.length, 0);
  assert.equal((await call('GET', '/api/admin/kb/chunks?lang=xx')).status, 400);

  const again = (await call('POST', '/api/admin/kb/reindex', { body: {} })).body;                       // nothing changed → nothing paid
  assert.deepEqual([again.changed, again.total], [0, 2]);
});

test('reindex is off without a Gemini key', async () => {
  env = { ...ENV, GEMINI_API_KEY: '' };
  const r = await call('POST', '/api/admin/kb/reindex', { body: {} });
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'feature_disabled');
});

test('without an answer: the refusals grouped by the words they share, no clients, keyword-only counted apart', async () => {
  const q = (text, answered, mode = 'hybrid', daysAgo = 1) => db.query(`INSERT INTO kb_queries (at, lang, query, mode, answered) VALUES ($1, 'ru', $2, $3, $4)`,
    [new Date(now().getTime() - daysAgo * 864e5), text, mode, answered]);
  await q('Есть ли в доме детская площадка во дворе?', false);
  await q('детская площадка во дворе есть?', false);
  await q('Можно ли с собакой жить в доме', false);
  await q('Когда сдача дома', true);
  await q('Когда сдача', false, 'keyword_only');
  await q('Очень старый вопрос про лифты', false, 'hybrid', 60);

  const r = (await call('GET', '/api/admin/kb/unanswered', { role: 'manager' })).body;
  assert.equal(r.groups.length, 2);
  assert.equal(r.groups[0].count, 2);
  assert.match(r.groups[0].query, /площадка/);
  assert.equal(r.groups[1].count, 1);
  assert.equal(r.keywordOnly, 1);
  assert.ok(!('clientId' in r.groups[0]) && !('conversationId' in r.groups[0]));
  assert.equal((await call('GET', '/api/admin/kb/unanswered?days=90')).body.groups.length, 3);
});
