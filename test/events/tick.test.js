// Deadlines without outside calls (04 §5–7): the tick, POST /api/jobs/run with the QStash signature, the daily Cron.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { fakeClock, now } from '../../server/core/clock.js';
import { createHold } from '../../server/core/bookings.js';
import { createTick, publishJobs, daily, runJobs } from '../../server/events/runner.js';
import { mountJobs } from '../../server/events/routes.js';
import { createTestDb, resetDb } from '../support/db.js';

let db, server, base;
const KEY = 'sig_test_current_key';
const ENV = { LINK_SECRET: 't', PUBLIC_URL: 'https://domus.test', QSTASH_CURRENT_SIGNING_KEY: KEY, QSTASH_NEXT_SIGNING_KEY: 'sig_next', CRON_SECRET: 'cron-secret' };
const WEB = { type: 'client', id: null, role: 'client', channel: 'telegram' };

before(async () => {
  db = await createTestDb();
  const app = express();
  mountJobs(app, db, { env: ENV }, { tick: async () => null });
  app.get('/api/x', (req, res) => res.json({ ok: true }));
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await db.close(); });
beforeEach(async () => {
  await resetDb(db);
  fakeClock.set('2026-10-28T10:00:00+05:00');
  await db.query(`INSERT INTO settings (key, value, updated_at) VALUES ('hold_minutes', '5', $1)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [now()]);
});
afterEach(() => fakeClock.reset());

const hold = () => createHold(db, { apartmentNo: 41, client: { telegram: { userId: 77, chatId: 77 } }, channel: 'telegram' }, WEB, { env: ENV });
const status = async id => (await db.one('SELECT status FROM bookings WHERE id = $1', [id])).status;

// A QStash-style token: HS256 JWT over { iss, sub = url, body = base64url(sha256(body)) }.
function qstashSig(body, key = KEY, url = `${ENV.PUBLIC_URL}/api/jobs/run`) {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const t = Math.floor(Date.now() / 1000);
  const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: 'Upstash', sub: url, exp: t + 300, nbf: t - 5, iat: t, jti: 'j1',
    body: crypto.createHash('sha256').update(body).digest('base64url') })}`;
  return `${head}.${crypto.createHmac('sha256', key).update(head).digest('base64url')}`;
}

test('the tick burns a hold with no outside call, and not more often than once per 5 s', async () => {
  const { booking } = await hold();
  const tick = createTick(db, { env: ENV });
  fakeClock.advance('5m');
  const r = await tick();
  assert.equal(r.swept, 1, 'the sweep closed it');
  assert.equal(r.done + r.skipped, 0, 'the sweep cancelled its hold.expire job');
  assert.equal((await db.one("SELECT status FROM jobs WHERE type = 'hold.expire'")).status, 'cancelled');
  assert.ok((await db.query("SELECT 1 FROM outbox WHERE template = 'hold_expired'")).length === 1, 'the client is told once');
  assert.equal(await status(booking.id), 'hold_expired');
  assert.equal(await tick(), null, 'throttled');
  fakeClock.advance('6s');
  assert.deepEqual(await tick(), { swept: 0, done: 0, skipped: 0, retried: 0, failed: 0 });
});

test('runJobs (npm run jobs:run) does the same; the sweep catches what has no job', async () => {
  const { booking } = await hold();
  await db.query(`UPDATE jobs SET status = 'cancelled'`);
  fakeClock.advance('6m');
  assert.equal((await runJobs(db, {}, { env: ENV })).done, 0);
  const r = await daily(db, { env: ENV });
  assert.equal(r.swept, 1);
  assert.equal(await status(booking.id), 'hold_expired');
});

test('daily: stale open payments get payment.reconcile; technical tables are cleaned', async () => {
  const { booking } = await hold();
  await db.query(`INSERT INTO payments (code, kind, booking_id, client_id, provider, amount, status, created_by, created_at, updated_at)
    VALUES ('P-1', 'deposit', $1, $2, 'card', 1, 'pending', '{}', $3, $3)`, [booking.id, booking.client_id, now()]);
  await db.query(`INSERT INTO idempotency_keys (scope, key, request_hash, created_at) VALUES ('hold', 'old', 'h', $1)`, [now()]);
  await db.query(`UPDATE bookings SET expires_at = $2 WHERE id = $1`, [booking.id, new Date(now().getTime() + 864e5)]);   // the hold outlives the stale scan
  fakeClock.advance('3h');
  const r = await daily(db, { env: ENV, handlers: { 'payment.reconcile': async () => 'done' } });
  assert.equal(r.reconcile, 1);
  fakeClock.advance('25h');
  assert.equal((await daily(db, { env: ENV, handlers: { 'payment.reconcile': async () => 'done' } })).cleaned.idempotency_keys, 1);
});

test('publishJobs: QStash gets the job id at run_at (at most 7 days − 1 h ahead), one dedup id per job and time', async () => {
  const sent = [];
  const client = { publishJSON: async m => { sent.push(m); return { messageId: `m${sent.length}` }; } };
  const j = await db.one(`INSERT INTO jobs (type, run_at, payload, status, created_at, updated_at) VALUES ('x', $1, '{}', 'scheduled', $1, $1) RETURNING id`, [now()]);
  const far = new Date(now().getTime() + 10 * 864e5);
  assert.equal(await publishJobs(db, [{ id: j.id, runAt: far }], { env: ENV, client }), 1);
  assert.equal(sent[0].url, 'https://domus.test/api/jobs/run');
  assert.deepEqual(sent[0].body, { jobId: j.id });
  assert.equal(sent[0].notBefore, Math.ceil((now().getTime() + 7 * 864e5 - 3600e3) / 1000));
  assert.equal((await db.one('SELECT qstash_message_id FROM jobs WHERE id = $1', [j.id])).qstash_message_id, 'm1');
  assert.equal(await publishJobs(db, [{ id: j.id, runAt: far }], { env: { ...ENV, PUBLIC_URL: '' }, client }), 0);
  assert.equal(await publishJobs(db, [{ id: j.id, runAt: far }], { env: { PUBLIC_URL: 'x' } }), 0, 'no token — skipped');
});

test('POST /api/jobs/run: 401 without a valid signature; with it the hinted job runs', async () => {
  const { booking } = await hold();
  const job = await db.one("SELECT id FROM jobs WHERE type = 'hold.expire'");
  fakeClock.advance('5m');
  const body = JSON.stringify({ jobId: job.id });
  const post = sig => fetch(`${base}/api/jobs/run`, { method: 'POST', headers: { 'content-type': 'application/json', ...(sig && { 'upstash-signature': sig }) }, body });
  assert.equal((await post(null)).status, 401);
  assert.equal((await post(qstashSig(body, 'wrong'))).status, 401);
  assert.equal((await post(qstashSig('{"jobId":0}'))).status, 401, 'the body hash must match');
  const ok = await post(qstashSig(body));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).done, 1);
  assert.equal(await status(booking.id), 'hold_expired');
});

test('GET /api/cron/daily: only with Authorization: Bearer CRON_SECRET', async () => {
  assert.equal((await fetch(`${base}/api/cron/daily`)).status, 401);
  assert.equal((await fetch(`${base}/api/cron/daily`, { headers: { authorization: 'Bearer nope' } })).status, 401);
  const r = await fetch(`${base}/api/cron/daily`, { headers: { authorization: `Bearer ${ENV.CRON_SECRET}` } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
});
