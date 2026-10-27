// Admin bookings and payments (12 §4, 13 §9.2, §9.5, 05 §12): lists and cards for managers and the head, extend / cancel for both,
// manual refund and its retry for the head only. Mounted after mountAdmin, so the staff gate is already in front; the head gate
// is added on the two refund routes and the core checks the role again (actor.role).
import crypto from 'node:crypto';
import { DomainError } from '../core/errors.js';
import { bookingsList, bookingCard, paymentsList, paymentCard } from '../core/adminLists.js';
import { extend, cancel } from '../core/bookings.js';
import { refundManual, retryRefund } from '../core/refunds.js';
import { bookingPath } from '../core/links.js';
import { now as clockNow } from '../core/clock.js';
import { handler, idempotencyKey, parseBody, z, tz } from './common.js';

const bookingNo = raw => {
  const no = Number(raw);
  if (!/^\d{1,9}$/.test(String(raw)) || no < 1) throw new DomainError('booking_not_found');
  return no;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Idempotency-Key of a staff change (13 §1.3): the same key with the same request returns the stored answer, with another
// request — 409. Only a finished answer is stored: after an error the repeat runs again and meets the same error.
async function once(db, ctx, scope, key, payload, run) {
  const hash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const k = await db.one('SELECT * FROM idempotency_keys WHERE scope = $1 AND key = $2', [scope, key]);
  if (k) {
    if (k.request_hash !== hash) throw new DomainError('idempotency_conflict');
    if (k.response) return { status: k.status, body: k.response };
  }
  const out = await run();
  await db.query(`INSERT INTO idempotency_keys (scope, key, request_hash, status, response, created_at) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT DO NOTHING`, [scope, key, hash, out.status, JSON.stringify(out.body), ctx.now()]);
  return out;
}

// opts — { env, onCommit, now } for the core.
export function mountAdminBookings(app, db, staffAuth, opts = {}) {
  const env = opts.env ?? process.env;
  const ctx = { ...opts, env, now: opts.now ?? clockNow };
  const at = () => tz(ctx.now());

  const idOf = async no => {
    const b = await db.one('SELECT id FROM bookings WHERE no = $1', [no]);
    if (!b) throw new DomainError('booking_not_found');
    return b.id;
  };
  // A change by a stale screen: 409 with the booking as it is now (13 §1.5).
  const fresh = async (no, req, fn) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof DomainError && e.code === 'stale') {
        const card = await bookingCard(db, no, req.actor, ctx);
        throw new DomainError('stale', { current: card?.booking ?? null });
      }
      throw e;
    }
  };

  app.get('/api/admin/bookings', handler(async (req, res) => {
    const { tab, q, cursor, limit } = req.query;
    const str = v => (typeof v === 'string' ? v : undefined);
    res.json({ ...await bookingsList(db, { tab: str(tab) ?? 'active', q: str(q), cursor: str(cursor), limit: str(limit) }, req.actor, ctx), at: at() });
  }));

  app.get('/api/admin/bookings/:no', handler(async (req, res) => {
    const no = bookingNo(req.params.no);
    const card = await bookingCard(db, no, req.actor, ctx);
    if (!card) throw new DomainError('booking_not_found');
    res.json({ ...card, at: at() });
  }));

  // The personal link is computed again each time, nothing is written (03 §14).
  app.get('/api/admin/bookings/:no/link', handler(async (req, res) => {
    const b = await db.one('SELECT id, no, access_version FROM bookings WHERE no = $1', [bookingNo(req.params.no)]);
    if (!b) throw new DomainError('booking_not_found');
    res.json({ link: bookingPath(b, env) });
  }));

  app.post('/api/admin/bookings/:no/extend', handler(async (req, res) => {
    const no = bookingNo(req.params.no);
    const key = idempotencyKey(req);
    const body = parseBody({
      hours: z.number().int().min(1).max(24 * 60).optional(), until: z.string().max(40).optional(),
      reason: z.string().max(300).optional(), expectedVersion: z.number().int().min(1)
    }, req.body);
    const out = await once(db, ctx, 'admin.extend', key, { no, body }, async () => fresh(no, req, async () => {
      await extend(db, { bookingId: await idOf(no), ...body }, req.actor, ctx);
      return { status: 200, body: { booking: (await bookingCard(db, no, req.actor, ctx)).booking } };
    }));
    res.status(out.status).json(out.body);
  }));

  app.post('/api/admin/bookings/:no/cancel', handler(async (req, res) => {
    const no = bookingNo(req.params.no);
    const key = idempotencyKey(req);
    const body = parseBody({
      initiator: z.enum(['client', 'developer']), reason: z.string().max(300).optional(), expectedVersion: z.number().int().min(1)
    }, req.body);
    const out = await once(db, ctx, 'admin.cancel', key, { no, body }, async () => fresh(no, req, async () => {
      await cancel(db, { bookingId: await idOf(no), ...body }, req.actor, ctx);
      const card = await bookingCard(db, no, req.actor, ctx);
      const refund = card.payments.find(p => p.refund)?.refund ?? null;
      return { status: 200, body: { booking: card.booking, ...(body.initiator === 'developer' && refund ? { refund } : {}) } };
    }));
    res.status(out.status).json(out.body);
  }));

  app.get('/api/admin/payments', handler(async (req, res) => {
    const str = k => (typeof req.query[k] === 'string' && req.query[k] !== '' ? req.query[k] : undefined);
    res.json({ ...await paymentsList(db, { provider: str('provider'), status: str('status'), from: str('from'), to: str('to'),
      cursor: str('cursor'), limit: str('limit') }, req.actor, ctx), at: at() });
  }));

  app.get('/api/admin/payments/:id', handler(async (req, res) => {
    const card = UUID.test(req.params.id) ? await paymentCard(db, req.params.id, req.actor, ctx) : null;
    if (!card) throw new DomainError('payment_not_found');
    res.json({ ...card, at: at() });
  }));

  // 05 §8, BR-14: the head only; the reason is required.
  app.post('/api/admin/payments/:id/refund', staffAuth.gate('head'), handler(async (req, res) => {
    if (!UUID.test(req.params.id)) throw new DomainError('payment_not_found');
    const key = idempotencyKey(req);
    const body = parseBody({ reason: z.string().max(300).optional() }, req.body);
    const out = await once(db, ctx, 'admin.refund', key, { id: req.params.id, body }, async () => {
      const r = await refundManual(db, { paymentId: req.params.id, ...body }, req.actor, ctx);
      return { status: 201, body: { refundId: r.refundId } };
    });
    res.status(out.status).json(out.body);
  }));

  app.post('/api/admin/refunds/:id/retry', staffAuth.gate('head'), handler(async (req, res) => {
    if (!UUID.test(req.params.id)) throw new DomainError('refund_not_allowed');
    const key = idempotencyKey(req);
    parseBody({}, req.body);
    const out = await once(db, ctx, 'admin.refund_retry', key, { id: req.params.id }, async () => {
      const r = await retryRefund(db, { refundId: req.params.id }, req.actor, ctx);
      return { status: 201, body: { refundId: r.refundId } };
    });
    res.status(out.status).json(out.body);
  }));
}
