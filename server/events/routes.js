// HTTP entries of the deadline mechanism (04 §5–7): the tick on API requests, POST /api/jobs/run (QStash),
// GET /api/cron/daily (Vercel Cron). Mounted before express.json(): the QStash signature is checked over the raw body.
import express from 'express';
import { waitUntil } from '@vercel/functions';
import { createTick, runJobs, daily, verifyQstash, cronAllowed } from './runner.js';

// Requests that do not wake the tick: the deadline routes themselves, webhooks, health.
const NO_TICK = /^\/api\/(jobs|cron|health|telegram|payments\/(stripe|click)\/)/;

// Work after the answer: on Vercel the function stays alive for it (waitUntil); a failure only goes to the log.
export const background = (promise, what) => waitUntil(promise.catch(e => console.error(`${what} failed:`, e.message)));

// opts — { env, send?, handlers? } for the runner; tick — a ready tick (tests).
export function mountJobs(app, db, opts = {}, { tick = createTick(db, opts) } = {}) {
  const env = opts.env ?? process.env;

  app.post('/api/jobs/run', express.raw({ type: '*/*', limit: '64kb' }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    if (!(await verifyQstash(raw, req.get('upstash-signature'), { env }))) {
      console.warn('jobs/run: bad signature');
      return res.status(401).json({ error: 'unauthorized' });
    }
    let hint = null;
    try { hint = JSON.parse(raw).jobId ?? null; } catch { /* an empty wake-up is fine */ }
    try {
      const r = await runJobs(db, { limit: 10, hint, budgetMs: 40_000 }, opts);
      res.json({ ok: true, ...r });
    } catch (e) {
      console.error('jobs/run failed:', e.message);
      res.status(503).json({ error: 'db_unavailable' });     // QStash repeats
    }
  });

  app.get('/api/cron/daily', async (req, res) => {
    if (!cronAllowed(req.get('authorization'), { env })) return res.status(401).json({ error: 'unauthorized' });
    try {
      const r = await daily(db, opts);
      console.log('cron daily', JSON.stringify(r));
      res.set('Cache-Control', 'no-store').json({ ok: true, ...r });
    } catch (e) {
      console.error('cron daily failed:', e.message);
      res.status(503).json({ error: 'db_unavailable' });
    }
  });

  app.use('/api', (req, res, next) => {
    if (!NO_TICK.test(req.originalUrl)) res.on('finish', () => background(tick(), 'tick'));
    next();
  });
}
