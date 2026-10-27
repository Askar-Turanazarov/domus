// The AI screens of the admin (12 §8, 13 §9.8): the journal of turns with the tree of one turn, the journal of tool calls, the costs,
// the knowledge base and its reindex. Staff see turns of their own clients (the core cuts them); the rest is the head's.
import path from 'node:path';
import { DomainError } from '../core/errors.js';
import { agentRuns, agentRunTree, toolCalls, aiCosts, kbChunks, kbUnanswered, reindexKb } from '../core/adminAi.js';
import { now as clockNow } from '../core/clock.js';
import { handler, parseBody, tz } from './common.js';

const flag = v => v === '1' || v === 'true';

// opts — { env, ai (the AI layer, for the reindex), kbRoot (the folder kb/) } and the core options.
export function mountAdminAi(app, db, staffAuth, opts = {}) {
  const env = opts.env ?? process.env;
  const ctx = { ...opts, env, now: opts.now ?? clockNow };
  const kbRoot = opts.kbRoot ?? path.join(import.meta.dirname, '..', '..', 'kb');
  const at = () => tz(ctx.now());
  const str = v => (typeof v === 'string' && v !== '' ? v : undefined);
  const head = staffAuth.gate('head');
  let reindexing = false;

  app.get('/api/admin/ai/runs', handler(async (req, res) => {
    const { problem, fallback, negative, errors, cursor, limit } = req.query;
    res.json({ ...await agentRuns(db, { problem: flag(problem), fallback: flag(fallback), negative: flag(negative), errors: flag(errors), cursor: str(cursor), limit: str(limit) }, req.actor, ctx), at: at() });
  }));

  app.get('/api/admin/ai/runs/:turnId', handler(async (req, res) => {
    const tree = await agentRunTree(db, req.params.turnId, req.actor, ctx);
    if (!tree) throw new DomainError('not_found');
    res.json({ ...tree, at: at() });
  }));

  app.get('/api/admin/ai/tools', head, handler(async (req, res) => {
    const { source, tool, ok, cursor, limit } = req.query;
    res.json({ ...await toolCalls(db, { source: str(source), tool: str(tool), ok: str(ok) == null ? null : flag(ok), cursor: str(cursor), limit: str(limit) }, req.actor, ctx), at: at() });
  }));

  app.get('/api/admin/ai/costs', head, handler(async (req, res) => {
    res.json({ ...await aiCosts(db, { days: str(req.query.days) }, req.actor, ctx), at: at() });
  }));

  app.get('/api/admin/kb/chunks', handler(async (req, res) => {
    res.json({ ...await kbChunks(db, { lang: str(req.query.lang), topic: str(req.query.topic) }, req.actor, ctx), at: at() });
  }));

  app.get('/api/admin/kb/unanswered', handler(async (req, res) => {
    res.json({ ...await kbUnanswered(db, { days: str(req.query.days) }, req.actor, ctx), at: at() });
  }));

  app.post('/api/admin/kb/reindex', head, handler(async (req, res) => {
    parseBody({}, req.body);
    if (reindexing) throw new DomainError('rate_limited');
    reindexing = true;
    try {
      res.json(await reindexKb(db, { ai: opts.ai, root: kbRoot, env }, req.actor, ctx));
    } finally { reindexing = false; }
  }));
}
