// Deferred jobs (04 §6): dedupe (I8), runDue once per job under concurrent runners, retries, stuck jobs, cancel.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock, now } from '../../server/core/clock.js';
import { schedule, cancel, runDue } from '../../server/core/jobs.js';
import { createTestDb, resetDb } from '../support/db.js';

let db;
before(async () => { db = await createTestDb(); });
after(() => db.close());
beforeEach(async () => { await resetDb(db); fakeClock.set('2026-10-28T10:00:00+05:00'); });
afterEach(() => fakeClock.reset());

const later = d => new Date(now().getTime() + d);
const status = async id => (await db.one('SELECT status, attempts, last_error, run_at FROM jobs WHERE id = $1', [id]));

test('schedule: one job per dedupe key (I8)', async () => {
  const a = await schedule(db, 'hold.expire', later(15 * 60e3), { bookingId: 'b1' }, 'hold.expire:b1:x');
  const b = await schedule(db, 'hold.expire', later(15 * 60e3), { bookingId: 'b1' }, 'hold.expire:b1:x');
  assert.ok(a);
  assert.equal(b, null);
  assert.equal((await db.one('SELECT count(*)::int AS n FROM jobs')).n, 1);
});

test('runDue: only due jobs (5 s slack), each in its own transaction, done / skipped', async () => {
  const seen = [];
  const handlers = { 'x.do': job => { seen.push(job.payload.n); return job.payload.n === 2 ? 'skipped' : 'done'; } };
  const j1 = await schedule(db, 'x.do', later(-1000), { n: 1 });
  const j2 = await schedule(db, 'x.do', later(4000), { n: 2 });
  const j3 = await schedule(db, 'x.do', later(60e3), { n: 3 });
  assert.deepEqual(await runDue(db, handlers), { done: 1, skipped: 1, retried: 0, failed: 0 });
  assert.deepEqual(seen.sort(), [1, 2]);
  assert.equal((await status(j1)).status, 'done');
  assert.equal((await status(j2)).status, 'skipped');
  assert.equal((await status(j3)).status, 'scheduled');
});

test('runDue: concurrent runners do each job exactly once (FOR UPDATE SKIP LOCKED)', async () => {
  const counts = new Map();
  const handlers = { 'x.do': job => { counts.set(job.id, (counts.get(job.id) ?? 0) + 1); return 'done'; } };
  for (let i = 0; i < 50; i++) await schedule(db, 'x.do', later(-1000), { i });
  const runs = await Promise.all(Array.from({ length: 5 }, () => runDue(db, handlers, { limit: 50 })));
  assert.equal(runs.reduce((s, r) => s + r.done, 0), 50);
  assert.equal(counts.size, 50);
  assert.ok([...counts.values()].every(n => n === 1));
});

test('runDue: a failing handler is retried 30 s → 2 m → 10 m → 1 h, then failed; the change rolls back', async () => {
  let calls = 0;
  const handlers = {
    'x.fail': async (job, { q }) => {
      calls++;
      await q.query("UPDATE settings SET value = '30' WHERE key = 'hold_minutes'");
      throw new Error('boom');
    }
  };
  const id = await schedule(db, 'x.fail', later(0), {});
  for (const wait of ['30s', '2m', '10m', '1h']) {
    assert.equal((await runDue(db, handlers)).retried, 1);
    const s = await status(id);
    assert.equal(s.status, 'scheduled');
    assert.equal(s.last_error, 'boom');
    assert.equal((await runDue(db, handlers)).retried, 0, 'not before its time');
    fakeClock.advance(wait);
  }
  assert.equal((await runDue(db, handlers)).failed, 1);
  assert.equal((await status(id)).status, 'failed');
  assert.equal(calls, 5);
  assert.equal((await db.one("SELECT value FROM settings WHERE key = 'hold_minutes'")).value, 15, 'rolled back');
});

test('runDue: a job stuck in running is picked up again after its 2-minute lock; unknown type fails safely', async () => {
  const id = await schedule(db, 'x.do', later(0), {});
  await db.query(`UPDATE jobs SET status = 'running', locked_until = $2, attempts = 1 WHERE id = $1`, [id, later(2 * 60e3)]);
  const handlers = { 'x.do': () => 'done' };
  assert.equal((await runDue(db, handlers)).done, 0);
  fakeClock.advance('2m');
  fakeClock.advance('1s');
  assert.equal((await runDue(db, handlers)).done, 1);
  const u = await schedule(db, 'x.unknown', later(0), {});
  assert.equal((await runDue(db, handlers)).retried, 1);
  assert.match((await status(u)).last_error, /no handler/);
});

test('runDue: the hinted job goes first; cancel by booking and by key', async () => {
  const order = [];
  const handlers = { 'x.do': job => { order.push(job.payload.n); return 'done'; } };
  await schedule(db, 'x.do', later(-5000), { n: 1 });
  const hint = await schedule(db, 'x.do', later(-1000), { n: 2 });
  await runDue(db, handlers, { hint, limit: 1 });
  assert.deepEqual(order, [2]);

  await schedule(db, 'booking.expire', later(60e3), { bookingId: 'b7' }, 'booking.expire:b7:1');
  await schedule(db, 'booking.expire', later(60e3), { bookingId: 'b8' }, 'booking.expire:b8:1');
  await schedule(db, 'booking.remind', later(60e3), { bookingId: 'b7' }, 'booking.remind:b7:1');
  assert.equal(await cancel(db, { type: 'booking.expire', bookingId: 'b7' }), 1);
  assert.equal(await cancel(db, { dedupeKey: 'booking.remind:b7:1' }), 1);
  assert.equal(await cancel(db, { dedupeKey: 'booking.remind:b7:1' }), 0);
  const left = await db.query("SELECT dedupe_key FROM jobs WHERE status = 'scheduled' AND type LIKE 'booking.%'");
  assert.deepEqual(left.map(r => r.dedupe_key), ['booking.expire:b8:1']);
});
