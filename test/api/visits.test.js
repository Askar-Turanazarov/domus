// The funnel counter (11 §11.1): POST /api/visit sets dvid once and counts one row per visitor and Tashkent day (a hash, no raw id);
// bots are not counted; the hold writes dvid into clients.visitor_id; the mini app counts by the Telegram user.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { fakeClock } from '../../server/core/clock.js';
import { requestId, noStore, apiErrors } from '../../server/http/common.js';
import { mountVisits } from '../../server/http/visits.js';
import { recordVisit, linkVisitor } from '../../server/core/analytics.js';
import { createTestDb, resetDb } from '../support/db.js';
import { makeClient } from '../support/factories.js';
import { ENV } from '../support/api.js';

let db, server, base;

before(async () => {
  db = await createTestDb();
  const app = express();
  app.use(requestId);
  app.use('/api', noStore);
  mountVisits(app, db, { env: ENV });
  app.use(apiErrors);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await db.close(); });
beforeEach(async () => { await resetDb(db); fakeClock.set('2026-10-28T10:00:00+05:00'); });
afterEach(() => fakeClock.reset());

const visit = (headers = {}) => fetch(base + '/api/visit', { method: 'POST', headers: { 'user-agent': 'Mozilla/5.0', ...headers } });
const rows = () => db.query('SELECT day::text AS day, visitor_hash, channel FROM analytics_visits ORDER BY first_at');

test('the first visit sets dvid (365 days, HttpOnly) and counts; a repeat that day does not; the next day counts again', async () => {
  const r = await visit();
  assert.equal(r.status, 204);
  const cookie = r.headers.get('set-cookie');
  assert.match(cookie, /^dvid=[A-Za-z0-9_-]{22}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=31536000$/);
  const dvid = cookie.split(';')[0];
  const again = await visit({ cookie: dvid });
  assert.equal(again.headers.get('set-cookie'), null, 'a known visitor keeps the cookie');
  let all = await rows();
  assert.equal(all.length, 1);
  assert.deepEqual([all[0].day, all[0].channel], ['2026-10-28', 'web']);
  assert.match(all[0].visitor_hash, /^[0-9a-f]{64}$/);
  assert.ok(!all[0].visitor_hash.includes(dvid.slice(5)), 'no raw id');
  fakeClock.set('2026-10-29T09:00:00+05:00');
  await visit({ cookie: dvid });
  all = await rows();
  assert.equal(all.length, 2);
  assert.notEqual(all[0].visitor_hash, all[1].visitor_hash, 'the salt of the day: days do not link up');
});

test('bots are not counted and get no cookie; a broken dvid is replaced', async () => {
  const bot = await visit({ 'user-agent': 'TelegramBot (like TwitterBot)' });
  assert.equal(bot.status, 204);
  assert.equal(bot.headers.get('set-cookie'), null);
  assert.equal((await rows()).length, 0);
  const broken = await visit({ cookie: 'dvid=<script>' });
  assert.match(broken.headers.get('set-cookie'), /^dvid=[A-Za-z0-9_-]{22};/);
});

test('the hold links dvid to the client once; the mini app counts by the Telegram user', async () => {
  const b = { client_id: (await makeClient(db)).id };
  await linkVisitor(db, { clientId: b.client_id, visitor: 'AAAAAAAAAAAAAAAAAAAAAA' });
  await linkVisitor(db, { clientId: b.client_id, visitor: 'BBBBBBBBBBBBBBBBBBBBBB' });
  assert.equal((await db.one('SELECT visitor_id FROM clients WHERE id = $1', [b.client_id])).visitor_id, 'AAAAAAAAAAAAAAAAAAAAAA');
  assert.equal(await recordVisit(db, { visitor: 'tg:77', channel: 'mini' }, { env: ENV }), true);
  assert.equal(await recordVisit(db, { visitor: 'tg:77', channel: 'mini' }, { env: ENV }), false);
  assert.deepEqual((await rows()).map(r => r.channel), ['mini']);
});
