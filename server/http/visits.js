// The visitor counter of the funnel (11 §11.1, FR-DSH-03): POST /api/visit from the showcase and the planner. The HTML of those pages
// is kept by the CDN (s-maxage), so the count is a small call after the page loads, not a cookie on the HTML: the page stays cached.
// No dvid yet → a new one in the cookie; bots are not counted; one row per visitor and day (repeat → nothing).
import crypto from 'node:crypto';
import { recordVisit } from '../core/analytics.js';
import { context } from '../core/tx.js';
import { handler, limit, ipKey, readDvid, setDvid, HOUR } from './common.js';

const BOT = /bot|crawl|spider|preview/i;

export function mountVisits(app, db, opts = {}) {
  const env = opts.env ?? process.env;
  app.post('/api/visit', handler(async (req, res) => {
    if (BOT.test(req.get('user-agent') ?? '')) return res.status(204).end();
    const ctx = context(opts);
    await limit(db, `visit:ip:${ipKey(req, env)}`, 60, HOUR, ctx);
    let dvid = readDvid(req);
    if (!dvid) {
      dvid = crypto.randomBytes(16).toString('base64url');
      setDvid(res, req, dvid);
    }
    await recordVisit(db, { visitor: dvid, channel: 'web' }, { env, now: ctx.now });
    res.status(204).end();
  }));
}
