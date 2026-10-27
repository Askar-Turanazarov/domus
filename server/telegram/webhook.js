// POST /api/telegram/webhook (10 §3): the secret, the repeat check, the answer at once, the work after it.
import crypto from 'node:crypto';
import express from 'express';
import { now as clockNow } from '../core/clock.js';
import { createBot } from './bot.js';
import { background } from '../events/routes.js';

// The header against TELEGRAM_WEBHOOK_SECRET in constant time (hashes first: the lengths may differ).
export function secretOk(header, secret) {
  if (!secret || !header) return false;
  const h = s => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(h(header), h(secret));
}

// 'message', 'callback_query', 'my_chat_member', … — the one key besides update_id.
export const kindOf = update => Object.keys(update).find(k => k !== 'update_id') ?? 'unknown';

// A short code for telegram_updates.error: no text of the message may get into the journal (NFR-SEC-02).
const codeOf = e => `${e?.name ?? 'Error'}${e?.error_code ? `:${e.error_code}` : ''}${e?.code ? `:${e.code}` : ''}`.slice(0, 100);

// opts — { env, core, bot?, defer?, now? }: bot — a ready one (tests); defer(promise) — the work after the answer (waitUntil).
export function mountTelegram(app, db, opts = {}) {
  const env = opts.env ?? process.env;
  const now = opts.now ?? clockNow;
  const defer = opts.defer ?? (p => background(p, 'telegram update'));
  let bot = opts.bot ?? null;
  const botOf = () => (bot ??= createBot({ db, env, core: opts.core }));

  async function handleOne(update) {
    try {
      await botOf().handleUpdate(update);
      await db.query('UPDATE telegram_updates SET done_at = $2 WHERE update_id = $1', [update.update_id, now()]);
    } catch (e) {
      console.error('telegram update failed:', codeOf(e));
      await db.query('UPDATE telegram_updates SET done_at = $2, error = $3 WHERE update_id = $1', [update.update_id, now(), codeOf(e)])
        .catch(() => {});
    }
  }

  app.post('/api/telegram/webhook',
    (req, res, next) => {
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) return res.status(503).json({ error: 'feature_disabled' });
      if (!secretOk(req.get('x-telegram-bot-api-secret-token'), env.TELEGRAM_WEBHOOK_SECRET)) return res.status(401).json({ error: 'unauthorized' });
      next();
    },
    express.json({ limit: '256kb' }),
    async (req, res) => {
      const update = req.body;
      if (!Number.isSafeInteger(update?.update_id)) return res.status(400).json({ error: 'invalid_input' });
      try {
        const fresh = await db.one(`INSERT INTO telegram_updates (update_id, kind, received_at) VALUES ($1, $2, $3)
          ON CONFLICT DO NOTHING RETURNING update_id`, [update.update_id, kindOf(update), now()]);
        res.json({ ok: true });                                          // at once (NFR-PERF-05); a repeat is answered the same
        if (fresh) defer(handleOne(update));
      } catch (e) {
        console.error('telegram webhook failed:', codeOf(e));
        if (!res.headersSent) res.status(503).json({ error: 'db_unavailable' });   // Telegram will repeat
      }
    });
}
