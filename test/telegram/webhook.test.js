// 10 §3: the secret (401 without logging the body), the repeat of update_id, the answer before the work, the journal.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { fakeClock } from '../../server/core/clock.js';
import { mountTelegram, secretOk, kindOf } from '../../server/telegram/webhook.js';
import { apiErrors } from '../../server/http/common.js';
import { createTestDb, resetDb } from '../support/db.js';
import { makeBot, start, callback, ENV } from './support.js';

let db;
before(async () => { db = await createTestDb(); });
after(() => db.close());
beforeEach(async () => { await resetDb(db); fakeClock.set('2026-10-28T10:00:00+05:00'); });
afterEach(() => fakeClock.reset());

// A server with the webhook only; `work` collects the deferred promises (waitUntil in production).
async function serve({ bot, env = ENV } = {}) {
  const app = express();
  const work = [];
  mountTelegram(app, db, { env, bot, defer: p => work.push(p) });
  app.use(apiErrors);
  const server = app.listen(0);
  const url = `http://127.0.0.1:${server.address().port}/api/telegram/webhook`;
  const post = (update, secret = ENV.TELEGRAM_WEBHOOK_SECRET) => fetch(url, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}) }, body: JSON.stringify(update) });
  return { post, work, close: () => server.close() };
}
const journal = () => db.query('SELECT * FROM telegram_updates ORDER BY update_id');

test('secretOk: constant-time comparison, empty values never pass', () => {
  assert.equal(secretOk('abc', 'abc'), true);
  assert.equal(secretOk('abd', 'abc'), false);
  assert.equal(secretOk('abcd', 'abc'), false);
  assert.equal(secretOk('', ''), false);
  assert.equal(secretOk(undefined, 'abc'), false);
  assert.equal(secretOk('abc', undefined), false);
});

test('a wrong or missing secret → 401, nothing is written, the bot is not touched', async () => {
  const { bot, calls } = makeBot(db);
  const s = await serve({ bot });
  try {
    for (const secret of ['wrong', '', 'w'.repeat(39)]) {
      const r = await s.post(start('', { id: 1, first_name: 'X' }), secret);
      assert.equal(r.status, 401);
      assert.deepEqual(await r.json(), { error: 'unauthorized' });
    }
    assert.deepEqual([(await journal()).length, s.work.length, calls.length], [0, 0, 0]);
  } finally { s.close(); }
});

test('the bot is off without a token or a secret: 503, not 200 (Telegram must not think the update was taken)', async () => {
  const s = await serve({ env: { ...ENV, TELEGRAM_BOT_TOKEN: '' } });
  try {
    assert.equal((await s.post(start())).status, 503);
    assert.equal((await journal()).length, 0);
  } finally { s.close(); }
});

test('a good update: 200 first, the work after; done_at in the journal; a repeat of update_id is not handled twice', async () => {
  const { bot, sent } = makeBot(db);
  const s = await serve({ bot });
  try {
    const update = start();
    const r = await s.post(update);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
    const [row] = await journal();
    assert.deepEqual([Number(row.update_id), row.kind], [update.update_id, 'message']);
    await Promise.all(s.work);
    assert.ok((await journal())[0].done_at, 'done_at after the work');
    const replies = sent().length;
    assert.ok(replies >= 1);

    const again = await s.post(update);
    assert.equal(again.status, 200, 'a repeat is answered the same way');
    assert.equal(s.work.length, 1, 'but not handled again');
    assert.equal(sent().length, replies);
    assert.equal((await journal()).length, 1);
  } finally { s.close(); }
});

test('the answer does not wait for the work (NFR-PERF-05): a slow bot, the 200 is already there', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const slow = { handleUpdate: async () => { await gate; } };
  const s = await serve({ bot: slow });
  try {
    const r = await s.post(start());
    assert.equal(r.status, 200);
    assert.equal((await journal())[0].done_at, null, 'still working');
    release();
    await Promise.all(s.work);
    assert.ok((await journal())[0].done_at);
  } finally { s.close(); }
});

test('a failing handler: done_at and a short error code, never the text of the message', async () => {
  const boom = { handleUpdate: async () => { throw Object.assign(new Error('secret words of the client'), { name: 'GrammyError', error_code: 400 }); } };
  const s = await serve({ bot: boom });
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  try {
    assert.equal((await s.post(start())).status, 200);
    await Promise.all(s.work);
    const [row] = await journal();
    assert.ok(row.done_at);
    assert.equal(row.error, 'GrammyError:400');
    assert.ok(!logged.join('\n').includes('secret words'), 'the log has the code only');
  } finally { console.error = orig; s.close(); }
});

test('a body without update_id → 400; kinds: callback_query and others are told apart', async () => {
  const s = await serve({ bot: { handleUpdate: async () => {} } });
  try {
    assert.equal((await s.post({ hello: 1 })).status, 400);
    assert.equal((await s.post(callback('x:1'))).status, 200);
    assert.equal((await journal())[0].kind, 'callback_query');
  } finally { s.close(); }
  assert.equal(kindOf({ update_id: 5, my_chat_member: {} }), 'my_chat_member');
  assert.equal(kindOf({ update_id: 5 }), 'unknown');
});

test('end to end: the real bot answers /start through the webhook', async () => {
  const { bot, sent } = makeBot(db);
  const s = await serve({ bot });
  try {
    await s.post(start('', { id: 4242, first_name: 'Дильшод', language_code: 'uz' }));
    await Promise.all(s.work);
    assert.match(sent().at(-1).payload.text, /^Assalomu alaykum/);
    assert.equal(sent().at(-1).payload.chat_id, 4242);
    assert.equal((await db.one('SELECT lang FROM clients WHERE telegram_user_id = 4242')).lang, 'uz');
  } finally { s.close(); }
});
