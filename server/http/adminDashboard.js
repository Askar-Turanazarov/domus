// The dashboard over HTTP (12 §9.8, 13 §10): summary, charts, the feed. The session gate stands on /api/dashboard/* (mountAdmin); the role
// decides what the core returns (D-26). Each request to /api/* also wakes the job runner (events/routes.js), so an open dashboard keeps the
// deadlines on time.
import { dashboardSummary, dashboardCharts, dashboardFeed } from '../core/analytics.js';
import { now as clockNow } from '../core/clock.js';
import { performance } from 'node:perf_hooks';
import { handler, tz } from './common.js';

// opts — { cacheMs (the answer of summary / charts is kept per period and role: several tabs do not multiply the load, 2 s; 0 in tests) } and the core options.
export function mountAdminDashboard(app, db, opts = {}) {
  const ctx = { ...opts, env: opts.env ?? process.env, now: opts.now ?? clockNow };
  const cacheMs = opts.cacheMs ?? 2000;
  const cache = new Map();
  const at = () => tz(ctx.now());
  const str = v => (typeof v === 'string' && v !== '' ? v : undefined);

  // The same period and role within cacheMs gets the same answer; an error is never kept.
  async function cached(kind, req, fn) {
    const key = `${kind}:${req.actor.role}:${str(req.query.period) ?? 'today'}`;
    const hit = cache.get(key);
    const t0 = ctx.now().getTime();
    if (hit && cacheMs > 0 && t0 - hit.at < cacheMs) return hit.body;
    const body = await fn();
    if (cache.size > 20) cache.clear();
    cache.set(key, { at: t0, body });
    return body;
  }

  // 12 §9: the server time of summary in Server-Timing (a cached answer is close to 0) — measured by npm run bench
  app.get('/api/dashboard/summary', handler(async (req, res) => {
    const t0 = performance.now();
    const body = await cached('summary', req, () => dashboardSummary(db, { period: str(req.query.period) }, req.actor, ctx));
    res.set('Server-Timing', `app;dur=${(performance.now() - t0).toFixed(1)}`).json({ ...body, at: at() });
  }));

  app.get('/api/dashboard/charts', handler(async (req, res) => {
    res.json({ ...await cached('charts', req, () => dashboardCharts(db, { period: str(req.query.period) }, req.actor, ctx)), at: at() });
  }));

  app.get('/api/dashboard/feed', handler(async (req, res) => {
    res.json({ ...await dashboardFeed(db, { after: str(req.query.after), limit: str(req.query.limit), lang: req.staff?.lang }, req.actor, ctx), at: at() });
  }));
}
