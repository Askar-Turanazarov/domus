// The Outbox window (12 §6, 13 §9.9, 04 §3.3): the last messages, a card with the preview, «send again». The head only: the gate is on
// every route and the core checks the role again.
import { DomainError } from '../core/errors.js';
import { outboxList, outboxCard, resendOutbox } from '../core/adminOutbox.js';
import { now as clockNow } from '../core/clock.js';
import { handler, parseBody, tz } from './common.js';

export function mountAdminOutbox(app, db, staffAuth, opts = {}) {
  const ctx = { ...opts, env: opts.env ?? process.env, now: opts.now ?? clockNow };
  const at = () => tz(ctx.now());
  const str = v => (typeof v === 'string' && v !== '' ? v : undefined);
  const head = staffAuth.gate('head');

  app.get('/api/admin/outbox', head, handler(async (req, res) => {
    const { status, target, template, cursor, limit } = req.query;
    res.json({ ...await outboxList(db, { status: str(status), target: str(target), template: str(template), cursor: str(cursor), limit: str(limit) }, req.actor, ctx), at: at() });
  }));

  app.get('/api/admin/outbox/:id', head, handler(async (req, res) => {
    const card = await outboxCard(db, req.params.id, req.actor, ctx);
    if (!card) throw new DomainError('not_found');
    res.json({ ...card, at: at() });
  }));

  app.post('/api/admin/outbox/:id/resend', head, handler(async (req, res) => {
    parseBody({}, req.body);
    res.json(await resendOutbox(db, req.params.id, req.actor, ctx));
  }));
}
