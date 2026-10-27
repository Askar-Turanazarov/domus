// The «Система» screen over HTTP (12 §10, 13 §9): settings, the services, the AI panel and the reset of a provider. The head only:
// the gate is on every route and the core checks the role again.
import { z } from 'zod';
import { DomainError } from '../core/errors.js';
import { listSettings, changeSetting, aiPanel, systemHealth, resetProvider } from '../core/adminSystem.js';
import { now as clockNow } from '../core/clock.js';
import { handler, parseBody, tz } from './common.js';

// opts — { env, ai, settings } and the core options.
export function mountAdminSystem(app, db, staffAuth, opts = {}) {
  const ctx = { ...opts, env: opts.env ?? process.env, now: opts.now ?? clockNow };
  const at = () => tz(ctx.now());
  const head = staffAuth.gate('head');

  app.get('/api/admin/settings', head, handler(async (req, res) => {
    res.json({ ...await listSettings(db, req.actor, ctx), at: at() });
  }));

  app.put('/api/admin/settings/:key', head, handler(async (req, res) => {
    const body = req.body ?? {};
    if (!('value' in body)) throw new DomainError('invalid_input', { fields: ['value'] });
    const { expectedUpdatedAt } = parseBody({ value: z.unknown(), expectedUpdatedAt: z.string().datetime({ offset: true }).nullable().optional() }, body);
    res.json(await changeSetting(db, req.params.key, { value: body.value, expectedUpdatedAt }, req.actor, ctx));
  }));

  app.get('/api/admin/system', head, handler(async (req, res) => {
    res.json({ services: await systemHealth(db, req.actor, ctx), ai: await aiPanel(db, req.actor, ctx), at: at() });
  }));

  app.post('/api/admin/ai/providers/:key/reset', head, handler(async (req, res) => {
    parseBody({}, req.body);
    res.json(await resetProvider(db, req.params.key, req.actor, ctx));
  }));
}
