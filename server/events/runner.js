// What runs after a core transaction and on its own (04 §5–7): delivery of Outbox rows, publishing jobs to QStash,
// the tick on requests, POST /api/jobs/run, the daily Cron. Without QSTASH_TOKEN publishing is skipped — the tick,
// the Cron and `npm run jobs:run` still close every deadline.
import { Client, Receiver } from '@upstash/qstash';
import { now as clockNow } from '../core/clock.js';
import { runDue } from '../core/jobs.js';
import { deliver } from '../core/outbox.js';
import { sweepDue, bookingJobHandlers } from '../core/bookings.js';
import { paymentJobHandlers } from '../core/payments.js';
import { refundJobHandlers } from '../core/refunds.js';
import { viewingJobHandlers } from '../core/viewingsDb.js';

const WEEK = 7 * 24 * 3600e3;
const HOUR = 3600e3;

// opts — { now, env, send?, render?, handlers? }: send(row) → Telegram result (D2-16); handlers — extra job types (tests).
// outbox.retry only marks the row: it is delivered after the run, outside the job's transaction (a send is not undone).
function allHandlers(opts) {
  const { handlers, fx } = bookingJobHandlers(opts);
  const pay = paymentJobHandlers(opts, fx);
  const refund = refundJobHandlers(opts, fx);
  const viewing = viewingJobHandlers(opts, fx);
  return {
    fx,
    handlers: {
      ...handlers,
      ...pay.handlers,
      ...refund.handlers,
      ...viewing.handlers,
      'outbox.retry': async job => {
        if (!opts.send) return 'skipped';
        fx.outbox.push(job.payload.outboxId);
        return 'done';
      },
      ...opts.handlers
    }
  };
}

// QStash wakes /api/jobs/run at run_at (free tier: at most 7 days ahead — a later job "jumps", 04 §6.3).
export async function publishJobs(db, jobs, { env = process.env, now = clockNow, client = null } = {}) {
  if (!jobs.length || !(client || env.QSTASH_TOKEN) || !env.PUBLIC_URL) return 0;
  const qstash = client ?? new Client({ token: env.QSTASH_TOKEN, baseUrl: env.QSTASH_URL || undefined });
  let n = 0;
  for (const { id, runAt } of jobs) {
    const at = Math.min(new Date(runAt).getTime(), now().getTime() + WEEK - HOUR);
    try {
      const r = await qstash.publishJSON({ url: `${env.PUBLIC_URL}/api/jobs/run`, body: { jobId: id }, notBefore: Math.ceil(at / 1000),
        deduplicationId: `${id}:${at}`, retries: 3 });
      await db.query('UPDATE jobs SET qstash_message_id = $2 WHERE id = $1', [id, r.messageId]);
      n++;
    } catch (e) {
      console.warn('qstash publish failed', id, e.message);   // the job is in the base: the tick or the Cron will take it
    }
  }
  return n;
}

// After COMMIT (ctx.onCommit, in waitUntil): deliver the new Outbox rows, publish the new jobs; jobs due now run at once.
export async function afterCommit(db, fx, opts = {}) {
  const now = opts.now ?? clockNow;
  if (opts.send && fx.outbox.length) await deliver(db, fx.outbox, opts.send, { now });
  if (fx.jobs.some(j => j.runAt.getTime() <= now().getTime() + 5e3)) await runJobs(db, { limit: 5 }, opts);
  await publishJobs(db, fx.jobs.filter(j => j.runAt.getTime() > now().getTime() + 5e3), opts);
}

// runDue with every handler, then what the handlers produced. → { done, skipped, retried, failed }.
export async function runJobs(db, { limit = 10, hint = null, budgetMs = 40_000 } = {}, opts = {}) {
  const { handlers, fx } = allHandlers(opts);
  const r = await runDue(db, handlers, { now: opts.now ?? clockNow, limit, hint, budgetMs });
  if (opts.send && fx.outbox.length) await deliver(db, fx.outbox, opts.send, { now: opts.now ?? clockNow });
  await publishJobs(db, fx.jobs, opts);
  return r;
}

// The tick (04 §5 layer 4): not more often than once per 5 s per function instance. → the result or null (throttled).
export function createTick(db, opts = {}, { everyMs = 5_000 } = {}) {
  let last = -Infinity, busy = null;
  return async function tick() {
    const t = (opts.now ?? clockNow)().getTime();
    if (busy || t - last < everyMs) return null;
    last = t;
    busy = (async () => {
      const swept = await sweepDue(db, { limit: 20 }, { ...opts, onCommit: null });
      const jobs = await runJobs(db, { limit: 5, budgetMs: 20_000 }, opts);
      return { swept: swept.length, ...jobs };
    })();
    try { return await busy; } finally { busy = null; }
  };
}

// The cleanup of technical tables (02 §7). → { table: deleted }.
const CLEANUP = {
  telegram_updates: `DELETE FROM telegram_updates WHERE received_at < $1::timestamptz - interval '7 days' RETURNING 1`,
  rate_limits: `DELETE FROM rate_limits WHERE window_start < $1::timestamptz - interval '2 days' RETURNING 1`,
  idempotency_keys: `DELETE FROM idempotency_keys WHERE created_at < $1::timestamptz - interval '24 hours' RETURNING 1`,
  pending_actions: `DELETE FROM pending_actions WHERE status IN ('expired', 'cancelled')
    AND expires_at < $1::timestamptz - interval '7 days' RETURNING 1`,
  payment_challenges: `DELETE FROM payment_challenges WHERE expires_at < $1::timestamptz - interval '1 day' RETURNING 1`,
  client_link_codes: `DELETE FROM client_link_codes WHERE expires_at < $1 RETURNING 1`,
  jobs: `DELETE FROM jobs WHERE status IN ('done', 'skipped', 'cancelled') AND updated_at < $1::timestamptz - interval '14 days' RETURNING 1`
};

// GET /api/cron/daily (04 §7): full sweep, a long runDue, stale payments reconciled, cleanup. → the summary for the log.
export async function daily(db, opts = {}) {
  const now = opts.now ?? clockNow;
  const swept = await sweepDue(db, { limit: 500 }, { ...opts, onCommit: null });
  const jobs = await runJobs(db, { limit: 200, budgetMs: 40_000 }, opts);
  const at = now();
  const stale = await db.query(`INSERT INTO jobs (type, run_at, payload, status, dedupe_key, created_at, updated_at)
    SELECT 'payment.reconcile', $1, jsonb_build_object('paymentId', id), 'scheduled', 'payment.reconcile:' || id, $1, $1
      FROM payments WHERE status IN ('pending', 'processing') AND created_at < $1::timestamptz - interval '2 hours'
    ON CONFLICT DO NOTHING RETURNING id`, [at]);
  const cleaned = {};
  for (const [table, sql] of Object.entries(CLEANUP)) cleaned[table] = (await db.query(sql, [at])).length;
  return { swept: swept.length, jobs, reconcile: stale.length, cleaned };
}

// QStash signature of POST /api/jobs/run (04 §6.4, 14 §8). raw — the body as it came. → true | false.
export async function verifyQstash(raw, signature, { env = process.env } = {}) {
  if (!signature || !env.QSTASH_CURRENT_SIGNING_KEY) return false;
  const receiver = new Receiver({ currentSigningKey: env.QSTASH_CURRENT_SIGNING_KEY, nextSigningKey: env.QSTASH_NEXT_SIGNING_KEY });
  try {
    return await receiver.verify({ signature, body: raw, url: `${env.PUBLIC_URL}/api/jobs/run` });
  } catch {
    return false;
  }
}

// GET /api/cron/daily: Vercel sends Authorization: Bearer <CRON_SECRET>.
export function cronAllowed(header, { env = process.env } = {}) {
  return Boolean(env.CRON_SECRET) && header === `Bearer ${env.CRON_SECRET}`;
}
