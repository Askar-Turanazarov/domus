// Furniture orders over HTTP (03 §13, 13 §4, §11; S): what the order page /o/<no>-<sig> shows, and the admin list, card,
// files, the stage and the Domus note (12 §12.2). The prepayment itself starts at POST /api/payments with ref 'o:<no>-<sig>'.
import { DomainError } from '../core/errors.js';
import { context } from '../core/tx.js';
import { now as clockNow } from '../core/clock.js';
import { orderByRef, orderView, listOrders, getOrder, setStage } from '../core/orders.js';
import { handler, idempotencyKey, once, parseBody, z, tz, langOf } from './common.js';

const FILES = ['plan.png', '3d.jpg'];

// opts — { env, onCommit, render } for the core.
export function mountOrders(app, db, opts = {}) {
  const env = opts.env ?? process.env;

  // 11 §6.6: the content, the estimate, the prepayment and the stage. No name and no phone: the link can be passed on (14 §4).
  app.get('/api/orders/by-ref/:ref', handler(async (req, res) => {
    const o = await orderByRef(db, req.params.ref, env);
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.json(await orderView(db, o, langOf(req), opts));
  }));
}

// Mounted after mountAdmin: the staff gate is already in front; the core checks the role again.
export function mountAdminOrders(app, db, staffAuth, opts = {}) {
  const env = opts.env ?? process.env;
  const ctx = { ...opts, env, now: opts.now ?? clockNow };
  const str = v => (typeof v === 'string' && v !== '' ? v : undefined);

  app.get('/api/admin/orders', handler(async (req, res) => {
    const { kind, stage, cursor, limit } = req.query;
    res.json({ ...await listOrders(db, { kind: str(kind), stage: str(stage), cursor: str(cursor), limit: str(limit) }, req.actor),
      at: tz(ctx.now()) });
  }));

  app.get('/api/admin/orders/:id', handler(async (req, res) => {
    res.json(await getOrder(db, req.params.id, req.actor));
  }));

  // The drawing and the 3D picture (Domus): only the two known names.
  app.get('/api/admin/orders/:id/:file', handler(async (req, res) => {
    if (!FILES.includes(req.params.file)) throw new DomainError('not_found');
    const o = await getOrder(db, req.params.id, req.actor);
    const f = await db.one('SELECT data FROM order_files WHERE order_id = $1 AND name = $2', [o.id, req.params.file]);
    if (!f) throw new DomainError('not_found');
    res.set('Cache-Control', 'private, no-store').type(req.params.file.endsWith('.png') ? 'png' : 'jpeg').send(Buffer.from(f.data));
  }));

  // 03 §13, FR-FURN-03: the next stage or cancelled, with expectedVersion; IK against a double click.
  app.post('/api/admin/orders/:id/stage', handler(async (req, res) => {
    const key = idempotencyKey(req);
    const body = parseBody({ stage: z.string().max(20), expectedVersion: z.number().int().min(1) }, req.body);
    const out = await once(db, ctx, 'admin.order_stage', key, { id: req.params.id, body, staff: req.actor.id }, async () => {
      const o = await getOrder(db, req.params.id, req.actor);
      await setStage(db, { orderId: o.id, stage: body.stage, expectedVersion: body.expectedVersion }, req.actor, ctx);
      return { status: 200, body: { order: await getOrder(db, o.id, req.actor) } };
    });
    res.status(out.status).json(out.body);
  }));

  // Domus: the manager's note to the order (kept in the order document).
  app.patch('/api/admin/orders/:id', handler(async (req, res) => {
    const body = parseBody({ note: z.string().max(2000) }, req.body);
    const o = await getOrder(db, req.params.id, req.actor);
    await db.query(`UPDATE orders SET doc = jsonb_set(doc, '{note}', to_jsonb($2::text)), updated_at = $3, version = version + 1 WHERE id = $1`,
      [o.id, body.note, context(ctx).now()]);
    res.json({ order: await getOrder(db, o.id, req.actor) });
  }));
}
