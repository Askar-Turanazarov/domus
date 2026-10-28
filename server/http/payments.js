// HTTP entries of the payment layer (05 §12). The card body is never logged (P6). Contracts — 13-api §5;
// the error table and the answer format are common to all entries (./common.js, 13 §1.2, §2).
import express from 'express';
import { DomainError } from '../core/errors.js';
import { startPayment, cancelPayment, paymentView } from '../core/payments.js';
import { context, inTx } from '../core/tx.js';
import { submitCard, confirmCard } from '../payments/card.js';
import { handleClick, submitClickCard, confirmClick } from '../payments/click.js';
import { handleStripeWebhook, stripeReturn } from '../payments/stripe.js';
import { parseRef } from '../core/links.js';
import { bookingByRef, holderOf } from './bookings.js';
import { orderByRef } from '../core/orders.js';
import { sendError, langOf, jsonBody, parseBody, z, idempotencyKey, limit, ipKey, HOUR, MINUTE } from './common.js';

export { sendError };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// opts — { env, onCommit } for the core (tests pass a clock-free env; the base clock is the core's).
export function mountPayments(app, db, opts = {}) {
  const env = opts.env ?? process.env;
  app.use('/api/payments', jsonBody);

  // fn(req) → the JSON answer. Personal pages: no cache, no referrer. `paced` — the emulator limits of 14 §5.
  const run = (fn, { paced = false } = {}) => async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    try {
      if (!UUID.test(req.params.id)) throw new DomainError('payment_not_found');
      if (paced) {
        await limit(db, `pay:id:${req.params.id}`, 10, MINUTE, context(opts));
        await limit(db, `pay:ip:${ipKey(req, env)}`, 30, MINUTE, context(opts));
      }
      res.json(await fn(req));
    } catch (e) {
      sendError(res, e, langOf(req), 'pay.form');
    }
  };

  // 05 §3, §12: start from the booking page. IK; the form shows the url (the emulator page, Stripe Checkout).
  app.post('/api/payments', async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    try {
      const body = parseBody({
        ref: z.string().max(80), provider: z.enum(['card', 'click', 'stripe']),
        consent: z.strictObject({ version: z.string().max(20) }).optional(), lang: z.enum(['ru', 'uz', 'en']).optional()
      }, req.body);
      const key = idempotencyKey(req);
      const isOrder = body.ref.startsWith('o:');                                                     // 'o:501-<sig>' — a furniture order
      const ref = isOrder ? body.ref.slice(2) : body.ref;
      if (!parseRef(ref)) throw new DomainError('invalid_input', { fields: ['ref'] });
      const row = isOrder ? await orderByRef(db, ref, env) : await bookingByRef(db, ref, env);
      await limit(db, `pay:ref:${isOrder ? 'o' : ''}${row.no}`, 10, HOUR, context(opts));
      const r = await startPayment(db, { target: isOrder ? { orderId: row.id } : { bookingId: row.id }, provider: body.provider,
        consent: body.consent ?? null, lang: langOf(req), idempotencyKey: key }, holderOf(row), opts);
      res.status(201).json(r);
    } catch (e) {
      sendError(res, e, langOf(req));
    }
  });

  app.get('/api/payments/:id', run(req => paymentView(db, req.params.id, langOf(req), opts)));

  app.post('/api/payments/:id/cancel', run(async req => {
    const ctx = context(opts);
    const row = await inTx(db, ctx, (q, fx) => cancelPayment(q, fx, ctx, { paymentId: req.params.id, why: 'cancelled_by_user',
      actor: { type: 'client', id: null, role: 'client', channel: 'web' } }));
    if (!row) throw new DomainError('payment_closed');
    return { status: row.status };
  }));

  app.post('/api/payments/:id/card', run(req =>
    submitCard(db, { paymentId: req.params.id, number: req.body?.number, expiry: req.body?.expiry }, opts), { paced: true }));
  app.post('/api/payments/:id/card/confirm', run(req =>
    confirmCard(db, { paymentId: req.params.id, code: req.body?.code, lang: langOf(req) }, opts), { paced: true }));
  app.post('/api/payments/:id/click/card', run(req =>
    submitClickCard(db, { paymentId: req.params.id, number: req.body?.number, expiry: req.body?.expiry }, opts), { paced: true }));
  app.post('/api/payments/:id/click/confirm', run(req =>
    confirmClick(db, { paymentId: req.params.id, code: req.body?.code, lang: langOf(req) }, opts), { paced: true }));

// Click calls these (05 §5.3): form-urlencoded (JSON is taken too), the answer is always 200 with the protocol error
  // field. Only a failure of ours (the base is down) answers 500 — Click then repeats, which is what we want.
  const click = action => async (req, res) => {
    try {
      res.json(await handleClick(db, req.body ?? {}, action, opts));
    } catch (e) {
      console.error('click callback failed:', e.message);
      res.status(500).json({ error: -7, error_note: 'Failed to update user' });
    }
  };
  const form = express.urlencoded({ extended: false, limit: '16kb' });
  app.post('/api/payments/click/prepare', form, click(0));
  app.post('/api/payments/click/complete', form, click(1));

  // Back from Stripe / live Click (05 §6.5): finish what the webhook may not have yet, then to the booking page.
  app.get('/pay/return', async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const id = String(req.query.payment ?? '');
    if (!UUID.test(id)) return res.status(404).end();
    try {
      const to = await stripeReturn(db, { payment: id, session_id: req.query.session_id, cancelled: req.query.cancelled }, opts);
      return to ? res.redirect(302, to) : res.status(404).end();
    } catch (e) {
      console.error('pay return failed:', e.message);
      return res.status(500).end();
    }
  });
}

// 05 §6.4: the raw body for the signature — mounted BEFORE the global express.json (01 §5.3, 13 §1.5).
// 400 — a bad signature; 500 — our failure, Stripe repeats.
export function mountStripeWebhook(app, db, opts = {}) {
  app.post('/api/payments/stripe/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
    try {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const r = await handleStripeWebhook(db, raw, req.get('stripe-signature'), opts);
      res.status(r.status).json(r.body);
    } catch (e) {
      console.error('stripe webhook failed:', e.message);
      res.status(500).json({ error: 'internal' });
    }
  });
}
