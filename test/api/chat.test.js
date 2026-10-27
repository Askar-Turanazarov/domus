// 13 §6 / 11 §5: the site chat over HTTP — POST /api/chat as a stream of events, the cookie of an anonymous visitor, the owner of a
// dialog, the form «Оставить телефон», the card «Да» → /api/chat/confirm, feedback, the messages of a dialog.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import crypto from 'node:crypto';
import { fakeClock } from '../../server/core/clock.js';
import { createAi } from '../../server/ai/index.js';
import { createTools } from '../../server/tools/registry.js';
import { createTurns } from '../../server/agents/turn.js';
import { mountChat, frame } from '../../server/http/chat.js';
import { requestId, noStore, apiErrors } from '../../server/http/common.js';
import { parseSse } from '../../public/js/chat/stream.js';
import { fakeProvider } from '../ai/fakes.js';
import { createTestDb, resetDb } from '../support/db.js';

let db, tools;
const ENV = { LINK_SECRET: 'test-secret', SESSION_SECRET: 'test-session', PUBLIC_URL: 'https://x.test', LOG_SALT: 'salt', GEMINI_API_KEY: 'x' };
const quiet = { warn() {}, error() {}, info() {} };
before(async () => { db = await createTestDb(); tools = createTools({ db, env: ENV, log: quiet }); });
after(() => db.close());
beforeEach(async () => { await resetDb(db); fakeClock.set('2026-10-28T10:00:00+05:00'); });
afterEach(() => fakeClock.reset());

const plan = o => ({ text: JSON.stringify({ lang: 'ru', agents: [], tasks: {}, handoff: false, injection: false, ...o }) });

async function start(script = {}) {
  const g = fakeProvider('gemini', script);
  const ai = createAi({ db, adapters: { gemini: g, anthropic: null }, env: ENV, log: quiet });
  const turns = createTurns({ db, ai, tools, env: ENV, log: quiet });
  const app = express();
  app.use(requestId);
  app.use('/api', noStore);
  mountChat(app, db, { turns, tools }, { env: ENV });
  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));
  app.use(apiErrors);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  // post(path, body) → { status, headers, events (for a stream), json }
  const call = async (method, path, body, extra = {}) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID(),
      ...(cookie ? { cookie } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.getSetCookie?.().find(c => c.startsWith('dcl='));
    if (set) cookie = set.split(';')[0];
    const text = await r.text();
    const stream = (r.headers.get('content-type') ?? '').startsWith('text/event-stream');
    return { status: r.status, headers: r.headers, text, events: stream ? [...parseSse(text)] : null, json: stream || !text ? null : JSON.parse(text) };
  };
  return { g, call, close: () => server.close(), cookie: () => cookie };
}
const kinds = events => events.map(e => e.event);

test('13 §6.1: a new dialog — Set-Cookie dcl before the stream, meta first, a status at once, done last; the text arrives in pieces', async () => {
  const { call, close, g } = await start({
    'gemini-3.5-flash-lite': [plan({ agents: ['smalltalk'] })]
  });
  const r = await call('POST', '/api/chat', { text: 'Привет, вы бот?', lang: 'ru' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/event-stream/);
  assert.equal(r.headers.get('x-accel-buffering'), 'no');
  assert.match(r.headers.get('cache-control'), /no-cache/);
  assert.ok(r.headers.getSetCookie().some(c => /^dcl=.+HttpOnly/.test(c)), 'the cookie names the anonymous client');
  assert.deepEqual(kinds(r.events).slice(0, 2), ['meta', 'status']);
  assert.equal(r.events[1].data.text, 'Думаю…', 'the first status comes before any model');
  assert.equal(kinds(r.events).at(-1), 'done');
  assert.ok(kinds(r.events).includes('text'));
  assert.match(r.events[0].data.conversationId, /^[0-9a-f-]{36}$/);
  const conv = await db.one('SELECT * FROM conversations');
  assert.equal(conv.channel, 'web');
  const c = await db.one('SELECT * FROM clients WHERE id = $1', [conv.client_id]);
  assert.equal(c.name, null);
  assert.equal(c.phone, null);
  close();
  void g;
});

test('13 §6.1: the same cookie and conversationId continue the dialog (no meta); a stranger gets 404 conversation_not_found', async () => {
  const a = await start({ 'gemini-3.5-flash-lite': [plan({ agents: ['smalltalk'] })] });
  const first = await a.call('POST', '/api/chat', { text: 'Привет' });
  const id = first.events[0].data.conversationId;
  const again = await a.call('POST', '/api/chat', { conversationId: id, text: 'Спасибо' });
  assert.equal(again.status, 200);
  assert.ok(!kinds(again.events).includes('meta'));
  assert.equal((await db.one('SELECT count(*)::int AS n FROM messages WHERE role = $1', ['user'])).n, 2);
  // someone without the cookie
  const b = await start({});
  const foreign = await b.call('POST', '/api/chat', { conversationId: id, text: 'Привет' });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.json.error, 'conversation_not_found');
  a.close(); b.close();
});

test('13 §6.1: exactly one of text / intent; unknown fields; a bad intent → 400 invalid_input', async () => {
  const { call, close } = await start();
  for (const body of [{}, { text: 'a', intent: 'show_free' }, { text: 'a', extra: 1 }, { intent: 'Show Free!' }, { text: 'x'.repeat(2001) }]) {
    const r = await call('POST', '/api/chat', body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 40));
    assert.equal(r.json.error, 'invalid_input');
  }
  assert.equal((await db.one('SELECT count(*)::int AS n FROM conversations')).n, 0, 'nothing is created for a bad request');
  close();
});

test('13 §6.1: a button with an intent runs code: show_free → block apartments, suggestions, done — no model', async () => {
  const { call, close, g } = await start();
  const r = await call('POST', '/api/chat', { intent: 'show_free', payload: {} });
  const ks = kinds(r.events);
  assert.deepEqual(ks.filter((k, i) => !(k === 'text' && ks[i - 1] === 'text')), ['meta', 'status', 'status', 'text', 'block', 'suggestions', 'done']);
  assert.equal(r.events.find(e => e.event === 'block').data.type, 'apartments');
  assert.equal(g.calls.length, 0);
  close();
});

test('11 §5.6: «Оставить телефон» (channel path) saves the number in the card and the dialog memory, not in a model', async () => {
  const { call, close, g } = await start();
  const first = await call('POST', '/api/chat', { text: 'Привет' });
  const id = first.events[0].data.conversationId;
  const r = await call('POST', '/api/chat', { conversationId: id, intent: 'leave_phone', payload: { name: 'Алишер', phone: '90 123 45 67' } });
  assert.equal(r.status, 200);
  assert.match(r.events.find(e => e.event === 'text').data.delta, /номер записал/);
  const conv = await db.one('SELECT * FROM conversations');
  assert.equal(conv.state.contactPhone, '+998901234567');
  const c = await db.one('SELECT * FROM clients WHERE id = $1', [conv.client_id]);
  assert.equal(c.phone, '+998901234567');
  assert.equal(c.name, 'Алишер');
  assert.equal(c.phone_verified, false);
  // a wrong number is an error before the stream
  const bad = await call('POST', '/api/chat', { conversationId: id, intent: 'leave_phone', payload: { phone: '123' } });
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error, 'phone_invalid');
  const out = JSON.stringify(g.calls.map(c => c.req));
  assert.ok(!out.includes('901234567'), 'the number never reached a model');
  close();
});

test('11 §5.6: call_manager with name and phone → the number is saved and the dialog goes to the manager', async () => {
  const { call, close } = await start();
  const r = await call('POST', '/api/chat', { intent: 'call_manager', payload: { name: 'Алишер', phone: '+998901234567' } });
  assert.equal(r.status, 200);
  assert.equal(kinds(r.events).at(-1), 'done');
  const conv = await db.one('SELECT * FROM conversations');
  assert.equal(conv.mode, 'human');
  assert.equal((await db.one("SELECT count(*)::int AS n FROM outbox WHERE template = 'staff_handoff'")).n, 1);
  close();
});

test('11 §5.4 / 13 §6.2: book → the card «confirm»; /api/chat/confirm yes → executed with the hold; a second «Да» is the same result', async () => {
  const { call, close } = await start();
  const first = await call('POST', '/api/chat', { text: 'Привет' });
  const id = first.events[0].data.conversationId;
  await call('POST', '/api/chat', { conversationId: id, intent: 'leave_phone', payload: { name: 'Алишер', phone: '+998901234567' } });
  const book = await call('POST', '/api/chat', { conversationId: id, intent: 'book', payload: { apartmentNo: 41 }, context: { apartmentNo: 41, page: 'building' } });
  const card = book.events.filter(e => e.event === 'block').map(e => e.data).find(b => b.type === 'confirm');
  assert.ok(card, 'the confirmation card');
  const pa = card.data.pendingActionId;
  assert.match(pa, /^[0-9a-f-]{36}$/);
  // someone else cannot answer it
  const other = await start({});
  const stolen = await other.call('POST', '/api/chat/confirm', { pendingActionId: pa, answer: 'yes' });
  assert.ok([403, 404].includes(stolen.status), `got ${stolen.status}`);
  assert.equal((await db.query('SELECT 1 FROM bookings')).length, 0);
  // the missing Idempotency-Key
  const noKey = await call('POST', '/api/chat/confirm', { pendingActionId: pa, answer: 'yes' }, { 'idempotency-key': '' });
  assert.equal(noKey.status, 400);
  const yes = await call('POST', '/api/chat/confirm', { pendingActionId: pa, answer: 'yes' });
  assert.equal(yes.status, 200);
  assert.equal(yes.json.status, 'executed');
  assert.equal(yes.json.result.type, 'create_booking');
  assert.match(yes.json.text, /№41/);
  assert.equal((await db.one('SELECT apartment_no FROM bookings')).apartment_no, 41);
  const again = await call('POST', '/api/chat/confirm', { pendingActionId: pa, answer: 'yes' });
  assert.equal(again.json.status, 'executed');
  assert.equal((await db.query('SELECT 1 FROM bookings')).length, 1, 'one booking');
  close(); other.close();
});

test('13 §6.2: «Отмена» on the card cancels the draft; an unknown draft → 404 pending_not_found', async () => {
  const { call, close } = await start();
  const first = await call('POST', '/api/chat', { text: 'Привет' });
  const id = first.events[0].data.conversationId;
  await call('POST', '/api/chat', { conversationId: id, intent: 'leave_phone', payload: { phone: '+998901234567' } });
  const book = await call('POST', '/api/chat', { conversationId: id, intent: 'book', payload: { apartmentNo: 41 } });
  const pa = book.events.filter(e => e.event === 'block').map(e => e.data).find(b => b.type === 'confirm').data.pendingActionId;
  const no = await call('POST', '/api/chat/confirm', { pendingActionId: pa, answer: 'no' });
  assert.equal(no.status, 200);
  assert.equal(no.json.status, 'cancelled');
  assert.equal((await db.one('SELECT status FROM pending_actions WHERE id = $1', [pa])).status, 'cancelled');
  const none = await call('POST', '/api/chat/confirm', { pendingActionId: crypto.randomUUID(), answer: 'yes' });
  assert.equal(none.status, 404);
  assert.equal(none.json.error, 'pending_not_found');
  close();
});

test('13 §6.2: the messages after an id (for the manager\'s answers) and 👍/👎 on an own answer only', async () => {
  const { call, close } = await start({ 'gemini-3.5-flash-lite': [plan({ agents: ['smalltalk'] })] });
  const first = await call('POST', '/api/chat', { text: 'Привет' });
  const id = first.events[0].data.conversationId;
  const msgs = await call('GET', `/api/chat/${id}/messages`);
  assert.equal(msgs.status, 200);
  assert.equal(msgs.json.mode, 'ai');
  assert.deepEqual(msgs.json.items.map(m => m.role), ['user', 'assistant']);
  const last = msgs.json.items.at(-1);
  assert.equal((await call('GET', `/api/chat/${id}/messages?after=${last.id}`)).json.items.length, 0);
  // a manager's line shows up
  await db.query("INSERT INTO messages (conversation_id, role, text, created_at) VALUES ($1, 'staff', 'Добрый день!', $2)", [id, new Date()]);
  await db.query("INSERT INTO messages (conversation_id, role, text, created_at) VALUES ($1, 'note', 'внутренняя заметка', $2)", [id, new Date()]);
  const more = await call('GET', `/api/chat/${id}/messages?after=${last.id}`);
  assert.deepEqual(more.json.items.map(m => [m.role, m.text]), [['staff', 'Добрый день!']]);
  const fb = await call('POST', '/api/chat/feedback', { messageId: last.id, value: -1, note: 'не то' });
  assert.equal(fb.status, 204);
  assert.deepEqual(await db.one('SELECT feedback, feedback_note FROM messages WHERE id = $1', [last.id]), { feedback: -1, feedback_note: 'не то' });
  const other = await start({});
  assert.equal((await other.call('GET', `/api/chat/${id}/messages`)).status, 404);
  assert.equal((await other.call('POST', '/api/chat/feedback', { messageId: last.id, value: 1 })).status, 404);
  close(); other.close();
});

test('13 §6.1: a turn still running → 409 turn_in_progress before the stream; nothing is saved', async () => {
  const { call, close } = await start();
  const first = await call('POST', '/api/chat', { text: 'Привет' });
  const id = first.events[0].data.conversationId;
  await db.query('UPDATE conversations SET turn_lock_until = $2, turn_lock_id = $3 WHERE id = $1', [id, new Date('2026-10-28T10:00:30+05:00'), crypto.randomUUID()]);
  const before = (await db.one('SELECT count(*)::int AS n FROM messages')).n;
  const r = await call('POST', '/api/chat', { conversationId: id, text: 'ещё' });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'turn_in_progress');
  assert.equal((await db.one('SELECT count(*)::int AS n FROM messages')).n, before);
  close();
});

test('frame(): the events of the sink as SSE text', () => {
  assert.equal(frame({ type: 'text', agent: 'finance', delta: 'Привет' }), 'event: text\ndata: {"agent":"finance","delta":"Привет"}\n\n');
  assert.equal(frame({ type: 'reset', agent: 'finance' }), 'event: reset\ndata: {"agent":"finance"}\n\n');
  assert.equal(frame({ type: 'done', data: { turnId: 'a', messageId: 2 } }), 'event: done\ndata: {"turnId":"a","messageId":2}\n\n');
});
