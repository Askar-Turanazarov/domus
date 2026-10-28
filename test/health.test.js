// /api/health statuses (16 §6) on a test base, without a server.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { health } from '../server/health.js';
import { fakeClock } from '../server/core/clock.js';
import { createTestDb, resetDb } from './support/db.js';

let db;
before(async () => { db = await createTestDb(); });
after(() => db.close());
afterEach(() => fakeClock.reset());

test('health: keys set → test / ok / qstash ok; the commit hash is the version', async () => {
  await resetDb(db);
  fakeClock.set('2026-11-02T09:00:00+05:00');
  const env = { QSTASH_TOKEN: 'x', TELEGRAM_BOT_TOKEN: 'x', STRIPE_SECRET_KEY: 'sk_test_x', GEMINI_API_KEY: 'x', VERCEL_GIT_COMMIT_SHA: 'a1b2c3d4e5' };
  const { code, body } = await health(db, { env, version: '1.0.0' });
  assert.equal(code, 200);
  assert.deepEqual(body, { status: 'ok', version: 'a1b2c3d', time: '2026-11-02T09:00:00+05:00', db: 'ok', qstash: 'ok',
    telegram: 'ok', stripe: 'test', click: 'emulator', ai: { gemini: { status: 'ok' }, anthropic: { status: 'off' } } });
  assert.equal((await health(db, { env: { STRIPE_SECRET_KEY: 'sk_live_x' } })).body.stripe, 'off');
});

test('health: a job 5+ minutes late → qstash degraded', async () => {
  await resetDb(db);
  fakeClock.set('2026-11-02T09:00:00+05:00');
  const t = new Date('2026-11-02T08:54:00+05:00');
  await db.query("INSERT INTO jobs (type, run_at, payload, status, created_at, updated_at) VALUES ('booking.expire', $1, '{}', 'scheduled', $1, $1)", [t]);
  assert.equal((await health(db, { env: { QSTASH_TOKEN: 'x' } })).body.qstash, 'degraded');
});

test('health: a migration behind → migration_needed, 503; no base → down, 503', async () => {
  await resetDb(db);
  await db.query("DELETE FROM schema_migrations WHERE version = '006_service'");
  const r = await health(db, { env: {} });
  assert.deepEqual([r.code, r.body.status, r.body.db], [503, 'down', 'migration_needed']);
  await db.query("INSERT INTO schema_migrations (version, applied_at) VALUES ('006_service', $1)", [new Date()]);
  const broken = { one: async () => { throw new Error('no connection'); }, query: async () => { throw new Error('no connection'); } };
  const d = await health(broken, { env: { QSTASH_TOKEN: 'x' } });
  assert.deepEqual([d.code, d.body.db, d.body.qstash], [503, 'down', 'down']);
});
