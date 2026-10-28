// 07 §9, 12 §5.4, 10 §8, 13 §9 (D5-05): dialogs «with a manager» — «позвать менеджера» puts the dialog to mode 'human' (the agent keeps
// quiet, the group hears of the client once per 5 min), the inbox with the longest waiting on top, the manager's reply (Idempotency-Key,
// staff message, staff_reply to Telegram), «Вернуть ИИ» by hand and by itself after 24 h without a reply; the agent's Outbox rows rendered.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { fakeClock } from '../../server/core/clock.js';
import { hashPassword } from '../../server/adminAuth.js';
import { createStaff } from '../../server/core/staff.js';
import { requestHandoff } from '../../server/core/clients.js';
import { createTools } from '../../server/tools/registry.js';
import { createTurns } from '../../server/agents/turn.js';
import { render } from '../../server/notify/render.js';
import { mountAdmin } from '../../server/http/admin.js';
import { mountAdminClients } from '../../server/http/adminClients.js';
import { requestId, apiErrors } from '../../server/http/common.js';
import { createTestDb, resetDb } from '../support/db.js';
import { staffReply } from '../../server/core/dialogs.js';
import { makeClient, asClient, asStaff } from '../support/factories.js';

const ENV = { LINK_SECRET: 'test-secret', SESSION_SECRET: 'x'.repeat(40), LOG_SALT: 'salt', PUBLIC_URL: 'https://x.test', TELEGRAM_STAFF_CHAT_ID: '-100' };
const PASSWORD = 'dialogs test password 1';
const quiet = { warn() {}, error() {} };
const core = { render: (tpl, lang, vars) => render(tpl, lang, vars, { publicUrl: ENV.PUBLIC_URL }) };
let db, tools, turns, server, base, cookie, staff, tg = 700;

before(async () => {
  db = await createTestDb();
  tools = createTools({ db, env: ENV });
  turns = createTurns({ db, ai: null, tools, env: ENV, log: quiet, core });
  const app = express();
  app.use(requestId);
  const staffAuth = mountAdmin(app, db, { env: ENV, cacheMs: 0 });
  mountAdminClients(app, db, staffAuth, { env: ENV, ...core });
  app.use(apiErrors);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); return db.close(); });

beforeEach(async () => {
  await resetDb(db);
  fakeClock.set('2026-10-28T10:00:00+05:00');
  staff = await createStaff(db, { login: 'd-manager', name: 'Азиз', role: 'manager', passwordHash: await hashPassword(PASSWORD) });
  const res = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'domus-admin' },
    body: JSON.stringify({ login: 'd-manager', password: PASSWORD }) });
  cookie = res.headers.get('set-cookie').split(';')[0];
});
afterEach(() => fakeClock.reset());

async function dialog({ channel = 'telegram', name = 'Аня' } = {}) {
  const c = await makeClient(db, { name, phone: '+998901234567', channel, tg: channel === 'telegram' ? ++tg : null, chat: channel === 'telegram' ? tg : null });
  const conv = await db.one(`INSERT INTO conversations (kind, client_id, channel, lang, created_at, updated_at)
    VALUES ('client', $1, $2, 'ru', $3, $3) RETURNING *`, [c.id, channel, new Date('2026-10-28T04:00:00Z')]);
  return { c, conv, say: text => turns.runTurn({ conversationId: conv.id, text, actor: asClient(c, channel), channel }) };
}
const handoff = ({ c, conv }) => requestHandoff(db, { clientId: c.id, conversationId: conv.id, reason: 'question' }, asClient(c), { env: ENV, ...core });
const call = (method, path, { body, key } = {}) => fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
  headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'domus-admin', Cookie: cookie, ...(key ? { 'Idempotency-Key': key } : {}) } });
const rows = tpl => db.query('SELECT vars, rendered, status, client_id FROM outbox WHERE template = $1 ORDER BY id', [tpl]);

test('«позвать менеджера» → mode human; the agent keeps quiet; the group hears of the client not more than once per 5 min', async () => {
  const d = await dialog();
  await handoff(d);
  const conv = await db.one('SELECT mode, state FROM conversations WHERE id = $1', [d.conv.id]);
  assert.equal(conv.mode, 'human');
  assert.equal(conv.state.humanSince, '2026-10-28T05:00:00.000Z');
  const ev = await db.one(`SELECT data FROM events WHERE type = 'conversation.mode_changed'`);
  assert.deepEqual(ev.data, { conversationId: d.conv.id, to: 'human', by: 'client' });

  assert.equal((await d.say('Когда будет скидка?')).status, 'human');
  fakeClock.advance('2m');
  assert.equal((await d.say('Алло?')).status, 'human');
  let pings = await rows('staff_client_message');
  assert.equal(pings.length, 1);
  assert.deepEqual(pings[0].vars, { name: 'Аня', preview: 'Когда будет скидка?', clientId: d.c.id });
  assert.match(pings[0].rendered.text, /💬 Аня: «Когда будет скидка\?»/);
  assert.match(JSON.stringify(pings[0].rendered.reply_markup), new RegExp(`/admin/clients/${d.c.id}`));
  fakeClock.advance('4m');
  await d.say('Есть кто?');
  pings = await rows('staff_client_message');
  assert.equal(pings.length, 2, 'more than 5 min after the first ping');
  const msgs = await db.query('SELECT role FROM messages WHERE conversation_id = $1 ORDER BY id', [d.conv.id]);
  assert.deepEqual(msgs.map(m => m.role), ['user', 'user', 'user'], 'no answer of the agent');
});

test('the agent\'s Outbox rows are rendered: staff_handoff from the chat carries its text', async () => {
  const d = await dialog();
  await turns.runTurn({ conversationId: d.conv.id, text: '', intent: 'call_manager', payload: {}, actor: asClient(d.c, 'telegram'), channel: 'telegram' });
  const [row] = await rows('staff_handoff');
  assert.ok(row, 'staff_handoff is written');
  assert.match(row.rendered.text, /Клиент просит менеджера/);
});

test('the inbox: dialogs with a manager, the longest waiting on top, answered after; a manager\'s reply clears «waiting»', async () => {
  const a = await dialog({ name: 'Аня' });
  const b = await dialog({ name: 'Борис', channel: 'web' });
  const z = await dialog({ name: 'С ИИ' });
  await handoff(a); await handoff(b);
  await b.say('Я первый');
  fakeClock.advance('1m');
  await a.say('Я второй');
  await z.say('Привет');
  let r = await (await call('GET', '/api/admin/conversations?mode=human')).json();
  assert.deepEqual(r.items.map(i => [i.name, i.waiting]), [['Борис', true], ['Аня', true]]);
  assert.equal(r.waiting, 2);
  assert.equal(r.items[0].phone, '+998 90 *** ** 67');
  assert.equal(r.items[0].lastText, 'Я первый');
  assert.equal((await call('POST', `/api/admin/conversations/${b.conv.id}/reply`, { body: { text: 'Здравствуйте!' }, key: 'reply-key-0001' })).status, 201);
  r = await (await call('GET', '/api/admin/conversations?mode=human')).json();
  assert.deepEqual(r.items.map(i => [i.name, i.waiting]), [['Аня', true], ['Борис', false]]);
  assert.equal(r.waiting, 1);
  assert.equal((await call('GET', '/api/admin/conversations')).status, 400, 'only mode=human');
});

test('the reply: Idempotency-Key, a staff message, staff_reply with the signature to Telegram; the site gets it by polling', async () => {
  const d = await dialog();
  await handoff(d);
  assert.equal((await call('POST', `/api/admin/conversations/${d.conv.id}/reply`, { body: { text: 'Да' } })).status, 400, 'no Idempotency-Key');
  const res = await call('POST', `/api/admin/conversations/${d.conv.id}/reply`, { body: { text: 'Скидка 3% до пятницы.' }, key: 'reply-key-0002' });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.message.role, 'staff');
  assert.equal(body.message.staffName, 'Азиз');
  const again = await call('POST', `/api/admin/conversations/${d.conv.id}/reply`, { body: { text: 'Скидка 3% до пятницы.' }, key: 'reply-key-0002' });
  assert.deepEqual(await again.json(), body, 'a double click sends once');
  const msgs = await db.query(`SELECT role, text FROM messages WHERE conversation_id = $1 AND role = 'staff'`, [d.conv.id]);
  assert.deepEqual(msgs, [{ role: 'staff', text: 'Скидка 3% до пятницы.' }]);
  const [out] = await rows('staff_reply');
  assert.equal(out.client_id, d.c.id);
  assert.equal(out.rendered.text, 'Скидка 3% до пятницы.\n\n— Азиз, отдел продаж');
  assert.equal((await call('POST', `/api/admin/conversations/${d.conv.id}/reply`, { body: { text: '' }, key: 'reply-key-0003' })).status, 400);

  const web = await dialog({ channel: 'web', name: 'Сайт' });
  await handoff(web);
  assert.equal((await call('POST', `/api/admin/conversations/${web.conv.id}/reply`, { body: { text: 'Ответ на сайт' }, key: 'reply-key-0004' })).status, 201);
  assert.equal((await rows('staff_reply')).length, 1, 'the site dialog: no Telegram message, the widget polls');
  assert.equal((await call('POST', '/api/admin/conversations/00000000-0000-4000-8000-000000000000/reply', { body: { text: 'x' }, key: 'reply-key-0005' })).status, 404);
});

test('«Вернуть ИИ»: mode ai, the line for the client, ai_returned to Telegram; again — nothing new', async () => {
  const d = await dialog();
  await handoff(d);
  const r = await call('POST', `/api/admin/conversations/${d.conv.id}/return-ai`, { body: {} });
  assert.deepEqual(await r.json(), { mode: 'ai' });
  assert.equal((await db.one('SELECT mode FROM conversations WHERE id = $1', [d.conv.id])).mode, 'ai');
  const m = await db.one(`SELECT role, text FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1`, [d.conv.id]);
  assert.deepEqual(m, { role: 'assistant', text: 'Дальше снова отвечает ИИ-консультант. Менеджер на связи, если понадобится.' });
  const [out] = await rows('ai_returned');
  assert.match(out.rendered.text, /снова отвечает ИИ-консультант/);
  const ev = await db.one(`SELECT data, staff_id FROM events WHERE type = 'conversation.mode_changed' AND data->>'to' = 'ai'`);
  assert.deepEqual([ev.data.by, ev.staff_id], ['staff', staff.id]);
  assert.deepEqual(await (await call('POST', `/api/admin/conversations/${d.conv.id}/return-ai`, { body: {} })).json(), { mode: 'ai' });
  assert.equal((await rows('ai_returned')).length, 1);
  assert.notEqual((await d.say('Привет')).status, 'human', 'the agent answers again');
});

test('24 h without a manager\'s reply: the next message of the client brings the AI back and is answered', async () => {
  const d = await dialog();
  await handoff(d);
  fakeClock.advance('23h');
  await staffReply(db, { conversationId: d.conv.id, text: 'Сейчас уточню' }, asStaff(staff), { env: ENV, ...core });   // the session cookie would be stale
  fakeClock.advance('23h');
  assert.equal((await d.say('Ну что?')).status, 'human', 'the reply restarted the 24 h');
  fakeClock.advance('2h');
  const r = await d.say('Привет');
  assert.notEqual(r.status, 'human');
  assert.equal((await db.one('SELECT mode FROM conversations WHERE id = $1', [d.conv.id])).mode, 'ai');
  const ev = await db.one(`SELECT data FROM events WHERE type = 'conversation.mode_changed' AND data->>'to' = 'ai'`);
  assert.equal(ev.data.by, 'timeout');
});
