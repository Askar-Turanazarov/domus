// Deferred jobs (04 §5–6, D-04): the job lives in Postgres; QStash, the tick and the daily Cron only wake runDue.
// Handlers are idempotent: a job that finds nothing to do ends as 'skipped'.
import { now as clockNow, toMs } from './clock.js';

const RETRY = ['30s', '2m', '10m', '1h'].map(toMs);   // after attempts 1…4; the 5th failure → failed
const MAX_ATTEMPTS = 5;
const LOCK_MS = 2 * 60e3;
const SLACK_MS = 5000;                                 // QStash and the base may disagree on the clock by a few seconds

// INSERT … ON CONFLICT (dedupe_key) DO NOTHING → the job id, or null when that key is already there (I8).
export async function schedule(q, type, runAt, payload, dedupeKey = null, { now = clockNow } = {}) {
  const at = now();
  const row = await q.one(
    `INSERT INTO jobs (type, run_at, payload, dedupe_key, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'scheduled', $5, $5) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [type, new Date(runAt), JSON.stringify(payload), dedupeKey, at]);
  return row?.id ?? null;
}

// cancel(q, {type, bookingId}) — every scheduled job of that type for the booking; cancel(q, {dedupeKey}) — one job.
// A cancelled job that QStash still delivers is a no-op. → how many were cancelled.
export async function cancel(q, { type, bookingId, dedupeKey }, { now = clockNow } = {}) {
  const rows = dedupeKey
    ? await q.query(`UPDATE jobs SET status = 'cancelled', updated_at = $2 WHERE status = 'scheduled' AND dedupe_key = $1 RETURNING id`,
      [dedupeKey, now()])
    : await q.query(`UPDATE jobs SET status = 'cancelled', updated_at = $3
        WHERE status = 'scheduled' AND type = $1 AND payload->>'bookingId' = $2 RETURNING id`, [type, bookingId, now()]);
  return rows.length;
}

// Claim due jobs (04 §6.5): scheduled and due, or running with an expired lock. FOR UPDATE SKIP LOCKED lets the tick,
// QStash and Cron run at once without doing a job twice.
async function claim(db, { at, limit, hint }) {
  return db.query(
    `WITH due AS (
       SELECT id FROM jobs
        WHERE (status = 'scheduled' AND run_at <= $1) OR (status = 'running' AND locked_until < $2)
        ORDER BY (id = $3) DESC, run_at
        LIMIT $4
        FOR UPDATE SKIP LOCKED)
     UPDATE jobs SET status = 'running', locked_until = $5, attempts = attempts + 1, updated_at = $2
      WHERE id IN (SELECT id FROM due)
     RETURNING *`,
    [new Date(at.getTime() + SLACK_MS), at, hint ?? null, limit, new Date(at.getTime() + LOCK_MS)]);
}

// handlers — { [type]: (job, {q, now}) → 'done' | 'skipped' }, each run in its own transaction; or { prepare, run }: prepare(job, {db, now})
// runs first outside the transaction (a slow call such as a model must not hold it) and its result goes to run(job, {q, now, prepared}).
// → { done, skipped, retried, failed } counts. budgetMs: no new job is started with less than 10 s left.
export async function runDue(db, handlers, { now = clockNow, limit = 10, hint = null, budgetMs = 40_000 } = {}) {
  const started = performance.now();
  const out = { done: 0, skipped: 0, retried: 0, failed: 0 };
  const jobs = await claim(db, { at: now(), limit, hint });
  for (const job of jobs) {
    if (performance.now() - started > budgetMs - 10_000) {
      // not started: back to the queue as it was
      await db.query(`UPDATE jobs SET status = 'scheduled', attempts = attempts - 1, locked_until = NULL WHERE id = $1 AND status = 'running'`, [job.id]);
      continue;
    }
    try {
      const handler = handlers[job.type];
      if (!handler) throw new Error(`no handler for ${job.type}`);
      const run = typeof handler === 'function' ? handler : handler.run;
      const prepared = handler.prepare ? await handler.prepare(job, { db, now }) : undefined;
      const result = await db.tx(async q => {
        const r = await run(job, { q, now, prepared });
        const status = r === 'skipped' ? 'skipped' : 'done';
        await q.query(`UPDATE jobs SET status = $2, done_at = $3, updated_at = $3, locked_until = NULL, last_error = NULL WHERE id = $1`,
          [job.id, status, now()]);
        return status;
      });
      out[result]++;
    } catch (e) {
      const at = now();
      const msg = String(e?.message ?? e).slice(0, 500);
      if (job.attempts < MAX_ATTEMPTS) {
        await db.query(`UPDATE jobs SET status = 'scheduled', run_at = $2, last_error = $3, locked_until = NULL, updated_at = $4 WHERE id = $1`,
          [job.id, new Date(at.getTime() + RETRY[job.attempts - 1]), msg, at]);
        out.retried++;
      } else {
        await db.query(`UPDATE jobs SET status = 'failed', last_error = $2, locked_until = NULL, updated_at = $3 WHERE id = $1`, [job.id, msg, at]);
        out.failed++;
      }
    }
  }
  return out;
}
