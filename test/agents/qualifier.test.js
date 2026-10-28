// 07 §13, 12 §5.2–5.3, 13 §9 (D5-04): the lead qualifier — the job 10 min after the client's last message, moved by each new one;
// the model's JSON under the rules of code; nothing new → skipped; no model → an hour later, 3 times, then rules only;
// «Переоценить» (202) and «Что ответить?» (a draft, nothing sent).
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { fakeClock, now } from '../../server/core/clock.js';
import { hashPassword } from '../../server/adminAuth.js';
import { createStaff } from '../../server/core/staff.js';
import { createAi } from '../../server/ai/index.js';
import { createTools } from '../../server/tools/registry.js';
import { createTurns } from '../../server/agents/turn.js';
import { rulesFloor } from '../../server/agents/qualifier.js';
import { runJobs } from '../../server/events/runner.js';
import { mountAdmin } from '../../server/http/admin.js';
import { mountAdminClients } from '../../server/http/adminClients.js';
import { requestId, apiErrors } from '../../server/http/common.js';
import { fakeProvider } from '../ai/fakes.js';
import { createTestDb, resetDb } from '../support/db.js';
import { makeClient, makeBooking, asClient } from '../support/factories.js';

const ENV = { LINK_SECRET: 'test-secret', SESSION_SECRET: 'x'.repeat(40), LOG_SALT: 'salt', PUBLIC_URL: 'https://x.test', GEMINI_API_KEY: 'x' };
const PASSWORD = 'qualifier test password 1';
const FAST = 'gemini-3.5-flash-lite';
const quiet = { warn() {}, error() {} };
let db, tools, g, ai, server, base, cookie;
const model = steps => { g = steps ? fakeProvider('gemini', { [FAST]: steps }) : null; };

before(async () => {
  db = await createTestDb();
  tools = createTools({ db, env: ENV });
  model([]);
  const adapter = { provider: 'gemini', call: (req, o) => (g ? g.call(req, o) : Promise.reject(Object.assign(new Error('down'), { status: 503 }))) };
  ai = createAi({ db, adapters: { gemini: adapter, anthropic: null }, env: ENV, log: quiet });
  const app = express();
  app.use(requestId);
  const staffAuth = mountAdmin(app, db, { env: ENV, cacheMs: 0 });
  mountAdminClients(app, db, staffAuth, { env: ENV, ai });
  app.use(apiErrors);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); return db.close(); });

beforeEach(async () => {
  await resetDb(db);
  fakeClock.set('2026-10-28T10:00:00+05:00');
  model([]);
  await createStaff(db, { login: 'q-manager', name: 'Азиз', role: 'manager', passwordHash: await hashPassword(PASSWORD) });
  const res = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'domus-admin' },
    body: JSON.stringify({ login: 'q-manager', password: PASSWORD }) });
  cookie = res.headers.get('set-cookie').split(';')[0];
});
afterEach(() => fakeClock.reset());

async function dialog(texts = []) {
  const c = await makeClient(db, { name: 'Аня', phone: '+998901234567' });
  const conv = await db.one(`INSERT INTO conversations (kind, client_id, channel, lang, created_at, updated_at)
    VALUES ('client', $1, 'web', 'ru', $2, $2) RETURNING *`, [c.id, new Date('2026-10-28T04:00:00Z')]);
  for (const [role, text] of texts) {
    await db.query(`INSERT INTO messages (conversation_id, role, text, created_at) VALUES ($1, $2, $3, $4)`, [conv.id, role, text, new Date('2026-10-28T04:30:00Z')]);
  }
  return { c, conv };
}
const answer = o => ({ text: JSON.stringify({ score: 'cold', summary: 'Ищет двушку до 900 млн, смотрел №41.', next_step: 'Позвонить и предложить показ', ...o }) });
const jobs = () => db.query(`SELECT status, run_at, payload, dedupe_key, created_at FROM jobs WHERE type = 'conversation.qualify' ORDER BY created_at, run_at`);
const run = () => runJobs(db, { limit: 10 }, { env: ENV, ai });
const later = min => fakeClock.advance(`${min}m`);
const lead = id => db.one('SELECT lead_score, lead_summary, lead_next_step, lead_scored_at, lead_scored_message_id FROM clients WHERE id = $1', [id]);

test('rules over the model: a paid booking → hot; a hold or a viewing → at least warm; one «привет» → cold', () => {
  const none = { paid: false, hold: false, viewing: false, apartmentsSeen: 0 };
  assert.equal(rulesFloor('cold', { ...none, paid: true }, ['a', 'b']), 'hot');
  assert.equal(rulesFloor('cold', { ...none, hold: true }, ['a', 'b']), 'warm');
  assert.equal(rulesFloor('hot', { ...none, viewing: true }, ['a', 'b']), 'hot', 'a floor never lowers');
  assert.equal(rulesFloor('warm', none, ['Привет!']), 'cold');
  assert.equal(rulesFloor('warm', none, ['Привет, есть двушки?']), 'warm');
  assert.equal(rulesFloor(undefined, none, []), 'cold', 'no model, no facts → cold');
});

test('each message of the client moves the job to «+10 min»; the old one is cancelled', async () => {
  model(null);
  const turns = createTurns({ db, ai: null, tools, env: ENV, log: quiet });
  const { c, conv } = await dialog();
  await turns.runTurn({ conversationId: conv.id, text: 'Привет', actor: asClient(c), channel: 'web' });
  later(3);
  await turns.runTurn({ conversationId: conv.id, text: 'Есть двушки?', actor: asClient(c), channel: 'web' });
  const js = await jobs();
  assert.deepEqual(js.map(j => j.status), ['cancelled', 'scheduled']);
  assert.equal(new Date(js[1].run_at).toISOString(), '2026-10-28T05:13:00.000Z');
  assert.deepEqual(js[1].payload, { conversationId: conv.id });
});

test('the job: the model JSON, the rules on top, client.scored; nothing new → skipped', async () => {
  const { c, conv } = await dialog([['user', 'Привет, нужна двушка до 900 млн'], ['assistant', 'Есть №41'], ['user', 'Отложите её']]);
  await makeBooking(db, { apartmentNo: 41, clientId: c.id, status: 'held' });
  model([answer({ score: 'cold' })]);
  await db.query(`INSERT INTO jobs (type, run_at, payload, status, created_at, updated_at) VALUES ('conversation.qualify', $1, $2, 'scheduled', $1, $1)`,
    [now(), JSON.stringify({ conversationId: conv.id })]);
  assert.equal((await run()).done, 1);
  const l = await lead(c.id);
  assert.equal(l.lead_score, 'warm', 'a hold lifts cold to warm');
  assert.equal(l.lead_summary, 'Ищет двушку до 900 млн, смотрел №41.');
  assert.equal(l.lead_next_step, 'Позвонить и предложить показ');
  const last = await db.one(`SELECT max(id) AS id FROM messages WHERE conversation_id = $1 AND role = 'user'`, [conv.id]);
  assert.equal(Number(l.lead_scored_message_id), Number(last.id));
  const req = g.calls[0].req;
  assert.match(req.system, /^You qualify a lead/);
  assert.match(req.messages[0].parts[0].text, /\[facts\] \{"paid":false,"hold":true,"viewing":false,"apartmentsSeen":0\}/);
  assert.match(req.messages[0].parts[0].text, /client: Отложите её/);
  const ev = await db.one(`SELECT client_id, data FROM events WHERE type = 'client.scored'`);
  assert.deepEqual([ev.client_id, ev.data], [c.id, { score: 'warm' }]);

  await db.query(`INSERT INTO jobs (type, run_at, payload, status, created_at, updated_at) VALUES ('conversation.qualify', $1, $2, 'scheduled', $1, $1)`,
    [now(), JSON.stringify({ conversationId: conv.id })]);
  assert.equal((await run()).skipped, 1, 'no new messages since the last score');
  assert.equal(g.calls.length, 1, 'the model is not called again (NFR-COST-04)');
});

test('no model: an hour later, 3 tries, then the score by rules only, without a summary', async () => {
  model(null);
  const { c, conv } = await dialog([['user', 'Привет']]);
  await db.query(`INSERT INTO jobs (type, run_at, payload, status, created_at, updated_at) VALUES ('conversation.qualify', $1, $2, 'scheduled', $1, $1)`,
    [now(), JSON.stringify({ conversationId: conv.id })]);
  await run();
  assert.equal((await lead(c.id)).lead_score, null);
  later(61); await run();
  assert.equal((await lead(c.id)).lead_score, null);
  later(61); await run();
  const l = await lead(c.id);
  assert.deepEqual([l.lead_score, l.lead_summary, l.lead_next_step], ['cold', null, null]);
  assert.deepEqual((await jobs()).map(j => [j.status, j.payload.attempt ?? 1]), [['done', 1], ['done', 2], ['done', 3]]);
});

const post = (path, body = {}) => fetch(base + path, { method: 'POST', body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'domus-admin', Cookie: cookie } });

test('«Переоценить» → 202 and a job due now that runs even without new messages; «Что ответить?» → a draft, nothing sent', async () => {
  const { c, conv } = await dialog([['user', 'Сколько стоит №41 в рассрочку?'], ['assistant', 'Посчитал на 12 месяцев'], ['user', 'А первый взнос?']]);
  await db.query(`UPDATE clients SET lead_score = 'cold', lead_scored_message_id = (SELECT max(id) FROM messages) WHERE id = $1`, [c.id]);
  const r = await post(`/api/admin/clients/${c.id}/rescore`);
  assert.equal(r.status, 202);
  assert.deepEqual(await r.json(), { queued: true, conversationId: conv.id });
  model([answer({ score: 'warm' })]);
  assert.equal((await run()).done, 1);
  assert.equal((await lead(c.id)).lead_score, 'warm');

  model([{ text: 'Первый взнос — от 30%, это [сумма]. Хотите, посчитаю точнее и пришлю?' }]);
  const h = await post(`/api/admin/conversations/${conv.id}/suggest-reply`);
  assert.equal(h.status, 200);
  assert.deepEqual(await h.json(), { draft: 'Первый взнос — от 30%, это [сумма]. Хотите, посчитаю точнее и пришлю?' });
  assert.match(g.calls[0].req.messages[0].parts[0].text, /\[language\] ru\n\[dialog\]\nclient: Сколько стоит/);
  const n = await db.one(`SELECT (SELECT count(*)::int FROM messages WHERE conversation_id = $1) AS m, (SELECT count(*)::int FROM outbox) AS o`, [conv.id]);
  assert.deepEqual(n, { m: 3, o: 0 }, 'nothing goes to the client');

  model(null);
  assert.equal((await post(`/api/admin/conversations/${conv.id}/suggest-reply`)).status, 503);
  assert.equal((await post(`/api/admin/conversations/00000000-0000-4000-8000-000000000000/suggest-reply`)).status, 404);
  const lone = await makeClient(db, { name: 'Без диалога' });
  assert.equal((await post(`/api/admin/clients/${lone.id}/rescore`)).status, 404);
});
