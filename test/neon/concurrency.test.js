// 15 §4: the tools of `npm run test:neon` — the guard, the QStash signature, the report, and one whole round of the
// steps on PGlite (the same operations, one connection: it proves the steps expect what the code really does; the real
// parallelism of 20 connections is what the run on the Neon branch adds).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mountBookings } from '../../server/http/bookings.js';
import { mountJobs, } from '../../server/events/routes.js';
import { verifyQstash } from '../../server/events/runner.js';
import { createTestDb } from '../support/db.js';
import { checkTestUrl, endpointOf } from '../../scripts/neon/guard.js';
import { qstashSignature } from '../../scripts/neon/qstash.js';
import { renderReport, summarize } from '../../scripts/neon/report.js';
import { runRound, STRIPE_ENV } from '../../scripts/neon/scenarios.js';

const PROD = 'postgresql://u:p@ep-cold-glade-123456-pooler.c-8.eu-central-1.aws.neon.tech/neondb?sslmode=require';
const BRANCH = 'postgresql://u:p@ep-quiet-test-654321.c-8.eu-central-1.aws.neon.tech/neondb?sslmode=require';

test('guard: no URL, a non-Postgres URL, and the production base (pooled or not, from the environment) are refused', () => {
  const none = '/nonexistent-root';
  assert.deepEqual(checkTestUrl(undefined, {}, none), { ok: false, reason: 'not_set' });
  assert.equal(checkTestUrl('https://example.com', {}, none).reason, 'not_a_postgres_url');
  assert.equal(endpointOf(PROD), 'ep-cold-glade-123456.c-8.eu-central-1.aws.neon.tech');
  assert.equal(checkTestUrl(PROD, { DATABASE_URL: PROD }, none).reason, 'is_a_known_base');
  assert.equal(checkTestUrl(PROD.replace('-pooler', ''), { DATABASE_URL: PROD }, none).reason, 'is_a_known_base', 'the direct host of the same base');
  assert.equal(checkTestUrl(PROD, { DATABASE_URL_UNPOOLED: PROD.replace('-pooler', '') }, none).reason, 'is_a_known_base');
  assert.deepEqual(checkTestUrl(BRANCH, { DATABASE_URL: PROD }, none), { ok: true, endpoint: 'ep-quiet-test-654321.c-8.eu-central-1.aws.neon.tech' });
});

test('the QStash signature made here is the one the site accepts, and only for that body and address', async () => {
  const opts = { key: 'k'.repeat(24), url: 'https://x.test/api/jobs/run' };
  const env = { QSTASH_CURRENT_SIGNING_KEY: opts.key, QSTASH_NEXT_SIGNING_KEY: 'next', PUBLIC_URL: 'https://x.test' };
  const sig = qstashSignature('{}', opts);
  assert.equal(await verifyQstash('{}', sig, { env }), true);
  assert.equal(await verifyQstash('{"a":1}', sig, { env }), false);
  assert.equal(await verifyQstash('{}', sig, { env: { ...env, PUBLIC_URL: 'https://y.test' } }), false);
});

test('the report: the verdict and the failures', () => {
  const ok = { round: 1, step: 'holds', attempts: 20, ok: 1, ms: 120, failures: [] };
  const bad = { round: 2, step: 'holds', attempts: 20, ok: 2, ms: 80, failures: ['2 holds succeeded, expected 1'] };
  assert.equal(summarize([ok]).pass, true);
  assert.equal(summarize([ok, bad]).pass, false);
  assert.equal(summarize([]).pass, false);
  const md = renderReport([ok, bad], { date: '2026-10-28', endpoint: 'ep-test', rounds: 2 });
  assert.match(md, /Verdict: \*\*FAIL\*\*/);
  assert.match(md, /round 2, holds: 2 holds succeeded/);
  assert.match(renderReport([ok], { date: '2026-10-28', endpoint: 'ep-test', rounds: 1 }), /Verdict: \*\*PASS\*\* — 0 double bookings/);
});

let db, server, base;
const ENV = { LINK_SECRET: 'test-secret', QSTASH_CURRENT_SIGNING_KEY: 'q'.repeat(24), QSTASH_NEXT_SIGNING_KEY: 'next', ...STRIPE_ENV };
before(async () => {
  db = await createTestDb();
  const app = express();
  app.set('trust proxy', 1);
  mountJobs(app, db, { env: ENV });                       // before the JSON parser, as in server.js
  app.use(express.json());
  mountBookings(app, db, { env: ENV });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  ENV.PUBLIC_URL = base;
});
after(async () => { server.close(); await db.close(); });

test('one round of all steps on PGlite: 1 hold of 20, 1 payment of 10, 1 Stripe event of 10, 1 Click Complete of 10, 50 jobs once', async () => {
  const results = await runRound(db, { round: 1, baseUrl: base, qstash: { key: ENV.QSTASH_CURRENT_SIGNING_KEY, url: `${base}/api/jobs/run` } });
  assert.deepEqual(results.map(r => r.step), ['holds', 'http-holds', 'payments', 'stripe-duplicates', 'click-duplicates', 'jobs']);
  for (const r of results) assert.deepEqual(r.failures, [], r.step);
  assert.deepEqual(results.map(r => [r.attempts, r.ok]), [[20, 1], [20, 1], [10, 1], [10, 1], [10, 1], [50, 50]]);
});

test('a second round starts from an emptied base (the rounds do not depend on each other)', async () => {
  const results = await runRound(db, { round: 2, baseUrl: base, qstash: { key: ENV.QSTASH_CURRENT_SIGNING_KEY, url: `${base}/api/jobs/run` } });
  assert.ok(results.every(r => !r.failures.length), JSON.stringify(results.flatMap(r => r.failures)));
});
