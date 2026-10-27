// Outbox (04 §3): every outgoing message, written in the change's transaction, rendered at once, sent after COMMIT.
// Delivery is «at least once»: a row is claimed before sending, so two deliverers never send the same row.
import { now as clockNow, toMs } from './clock.js';
import { schedule } from './jobs.js';

const RETRY = ['30s', '2m', '10m', '1h', '6h'].map(toMs);   // network / 5xx; after 6 attempts → failed
const MAX_ATTEMPTS = 6;
const CLAIM_MS = 2 * 60e3;                                 // a row stuck in 'sending' this long is free again

// The recipient (04 §3.1 step 1) → { chatId, lang, skip }.
async function recipient(q, { audience, clientId, staffId }, env) {
  if (audience === 'client') {
    const c = clientId && await q.one('SELECT telegram_chat_id, tg_blocked_at, lang FROM clients WHERE id = $1', [clientId]);
    if (!c?.telegram_chat_id) return { chatId: null, lang: c?.lang ?? 'ru', skip: 'no_telegram' };
    if (c.tg_blocked_at) return { chatId: c.telegram_chat_id, lang: c.lang, skip: 'blocked' };
    return { chatId: c.telegram_chat_id, lang: c.lang, skip: null };
  }
  if (audience === 'staff_group') {
    const chat = env.TELEGRAM_STAFF_CHAT_ID;
    return { chatId: chat ? Number(chat) : null, lang: 'ru', skip: chat ? null : 'disabled' };
  }
  const s = staffId && await q.one('SELECT telegram_user_id, lang FROM staff WHERE id = $1', [staffId]);
  return { chatId: s?.telegram_user_id ?? null, lang: s?.lang ?? 'ru', skip: s?.telegram_user_id ? null : 'no_telegram' };
}

// message — { template, audience, clientId?, staffId?, vars, eventId?, dedupeKey?, op?, editMessageId?, attachment? };
// render(template, lang, vars) → { text, parse_mode, reply_markup } (notify/render.js). → { id, status } | null (the dedupe
// key is already there, I7).
export async function enqueue(q, message, { now = clockNow, env = process.env, render = null } = {}) {
  const { template, audience, clientId = null, staffId = null, vars = {}, eventId = null, dedupeKey = null,
    op = 'send', editMessageId = null, attachment = null } = message;
  const r = await recipient(q, { audience, clientId, staffId }, env);
  const skip = env.NOTIFY_MODE === 'off' ? 'off' : r.skip;
  const rendered = render ? render(template, r.lang, vars) : null;
  const at = now();
  const row = await q.one(
    `INSERT INTO outbox (created_at, event_id, audience, op, chat_id, client_id, staff_id, template, lang, vars, rendered,
                         edit_message_id, attachment, status, skip_reason, next_attempt_at, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id, status`,
    [at, eventId, audience, op, r.chatId, clientId, staffId, template, r.lang, JSON.stringify(vars),
      rendered && JSON.stringify(rendered), editMessageId, attachment && JSON.stringify(attachment),
      skip ? 'skipped' : 'pending', skip, skip ? null : at, dedupeKey]);
  return row ?? null;
}

// A Telegram answer → the row's fate (04 §3.2). result: { ok, messageId? } | { ok: false, status?, retryAfter?, description? }
// | { ok: false, network: true }. Pure.
export function classify(result, op = 'send') {
  if (result.ok) return { status: 'sent' };
  if (result.status === 429) return { status: 'retry', delayMs: (result.retryAfter ?? 30) * 1000 };
  if (result.status === 403) return { status: 'skipped', reason: 'blocked' };
  if (result.status === 400 && op === 'edit' && /message is not modified/i.test(result.description ?? '')) return { status: 'sent' };
  if (result.status === 400) return { status: 'failed', error: result.description ?? 'bad request' };
  return { status: 'retry' };                                           // network, timeout, 5xx
}

// send(row) → a Telegram result as classify() takes it; it never throws (a throw counts as a network error).
// Called right after COMMIT (waitUntil) and from the outbox.retry job. → { sent, retry, skipped, failed }.
export async function deliver(db, ids, send, { now = clockNow } = {}) {
  const out = { sent: 0, retry: 0, skipped: 0, failed: 0 };
  for (const id of ids) {
    const at = now();
    const row = await db.one(
      `UPDATE outbox SET status = 'sending', attempts = attempts + 1, next_attempt_at = $2
        WHERE id = $1 AND (status IN ('pending', 'retry') OR status = 'sending')
          AND (next_attempt_at IS NULL OR next_attempt_at <= $3)
        RETURNING *`, [id, new Date(at.getTime() + CLAIM_MS), at]);
    if (!row) continue;
    let result;
    try { result = await send(row); } catch (e) { result = { ok: false, network: true, description: String(e?.message ?? e) }; }
    const fate = classify(result, row.op);
    const done = now();
    if (fate.status === 'sent') {
      await db.query(`UPDATE outbox SET status = 'sent', sent_at = $2, tg_message_id = COALESCE($3, tg_message_id), last_error = NULL,
        next_attempt_at = NULL WHERE id = $1`, [id, done, result.messageId ?? null]);
    } else if (fate.status === 'skipped') {
      await db.tx(async q => {
        await q.query(`UPDATE outbox SET status = 'skipped', skip_reason = $2, next_attempt_at = NULL WHERE id = $1`, [id, fate.reason]);
        if (row.audience === 'client' && row.client_id) {
          await q.query('UPDATE clients SET tg_blocked_at = $2 WHERE id = $1 AND tg_blocked_at IS NULL', [row.client_id, done]);
        }
      });
    } else if (fate.status === 'retry' && row.attempts < MAX_ATTEMPTS) {
      const next = new Date(done.getTime() + (fate.delayMs ?? RETRY[row.attempts - 1]));
      await db.tx(async q => {
        await q.query(`UPDATE outbox SET status = 'retry', next_attempt_at = $2, last_error = $3 WHERE id = $1`,
          [id, next, (result.description ?? 'network').slice(0, 500)]);
        await schedule(q, 'outbox.retry', next, { outboxId: Number(id) }, `outbox.retry:${id}:${row.attempts}`, { now });
      });
    } else {
      await db.query(`UPDATE outbox SET status = 'failed', last_error = $2, next_attempt_at = NULL WHERE id = $1`,
        [id, (fate.error ?? result.description ?? 'network').slice(0, 500)]);
      fate.status = 'failed';
    }
    out[fate.status]++;
  }
  return out;
}

// Rows due for another try (pending, retry, or stuck in sending) → deliver them. The daily Cron and the tick use it.
export async function retryDue(db, send, { now = clockNow, limit = 20 } = {}) {
  const rows = await db.query(
    `SELECT id FROM outbox WHERE status IN ('pending', 'retry', 'sending') AND next_attempt_at <= $1
      ORDER BY next_attempt_at LIMIT $2`, [now(), limit]);
  return deliver(db, rows.map(r => r.id), send, { now });
}
