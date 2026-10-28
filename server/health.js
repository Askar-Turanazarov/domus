// GET /api/health (13 §8.3, 16 §6): statuses only, no secrets, no request to a model. 200 if the base is ok, else 503.
// Telegram and the AI providers: ok when their key is set, off when it is not (no call to them from here).
// The staff details (queues, webhook errors, AI spend) come with the admin (12 §10.2).
import { pendingMigrations } from './db/migrate.js';
import { now as clockNow } from './core/clock.js';

// 2026-11-02T04:00Z → '2026-11-02T09:00:00+05:00'
const tashkent = d => new Date(d.getTime() + 5 * 3600e3).toISOString().slice(0, 19) + '+05:00';

async function dbStatus(db) {
  try {
    await db.one('SELECT 1');
    return (await pendingMigrations(db)).length ? 'migration_needed' : 'ok';
  } catch {
    return 'down';
  }
}

// Scheduled jobs more than 5 minutes late mean QStash does not call us back.
async function qstashStatus(db, env, at) {
  if (!env.QSTASH_TOKEN) return 'off';
  try {
    const late = await db.one("SELECT 1 FROM jobs WHERE status = 'scheduled' AND run_at < $1 LIMIT 1", [new Date(at - 5 * 60e3)]);
    return late ? 'degraded' : 'ok';
  } catch {
    return 'down';
  }
}

const later = key => (key ? 'ok' : 'off');

export async function health(db, { env = process.env, now = clockNow, version = '' } = {}) {
  const at = now();
  const dbs = await dbStatus(db);
  const body = {
    status: dbs === 'ok' ? 'ok' : 'down',
    version: env.VERCEL_GIT_COMMIT_SHA ? env.VERCEL_GIT_COMMIT_SHA.slice(0, 7) : version,
    time: tashkent(at),
    db: dbs,
    qstash: dbs === 'ok' ? await qstashStatus(db, env, at) : (env.QSTASH_TOKEN ? 'down' : 'off'),
    telegram: later(env.TELEGRAM_BOT_TOKEN),
    stripe: env.STRIPE_SECRET_KEY?.startsWith('sk_test_') ? 'test' : 'off',
    click: env.CLICK_MODE || 'emulator',
    ai: { gemini: { status: later(env.GEMINI_API_KEY) }, anthropic: { status: later(env.ANTHROPIC_API_KEY) } }
  };
  return { code: dbs === 'ok' ? 200 : 503, body };
}
