// HTTP entries of the payment layer (05 §12). The card body is never logged (P6). Contracts — 13-api §5;
// the common error table of 13 §2 comes with the API task (D2-12), here — the payment codes of 05 §13.
import express from 'express';
import { DomainError } from '../core/errors.js';
import { submitCard, confirmCard } from '../payments/card.js';
import { handleClick, submitClickCard, confirmClick } from '../payments/click.js';
import { handleStripeWebhook, stripeReturn } from '../payments/stripe.js';
import { t } from '../i18n/index.js';

const STATUS = {
  payment_not_found: 404, payment_closed: 409, booking_already_paid: 409, hold_expiring: 409, provider_unavailable: 409,
  provider_error: 502, card_invalid: 422, card_expired: 422, card_not_supported: 422, wrong_code: 422,
  consent_required: 422, booking_closed: 409, booking_not_found: 404, invalid_input: 400, forbidden: 403, idempotency_conflict: 409
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LANGS = ['ru', 'uz', 'en'];

const langOf = req => [req.body?.lang, req.query.lang].find(l => LANGS.includes(l)) ?? 'ru';

// DomainError → { error, message?, ...vars } with its status; anything else → 500 without details.
export function sendError(res, e, lang = 'ru') {
  if (!(e instanceof DomainError)) {
    console.error('payments:', e.message);
    return res.status(500).json({ error: 'internal' });
  }
  const message = t(lang, `pay.form.${e.code}`, e.vars) ?? undefined;
  return res.status(STATUS[e.code] ?? 400).json({ error: e.code, message, ...e.vars });
}

// opts — { env } for the core (tests pass a clock-free env; the base clock is the core's).
export function mountPayments(app, db, opts = {}) {
  const run = fn => async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    try {
      if (!UUID.test(req.params.id)) throw new DomainError('payment_not_found');
      res.json(await fn(req));
    } catch (e) {
      sendError(res, e, langOf(req));
    }
  };

  app.post('/api/payments/:id/card', run(req =>
    submitCard(db, { paymentId: req.params.id, number: req.body?.number, expiry: req.body?.expiry }, opts)));
  app.post('/api/payments/:id/card/confirm', run(req =>
    confirmCard(db, { paymentId: req.params.id, code: req.body?.code, lang: langOf(req) }, opts)));
  app.post('/api/payments/:id/click/card', run(req =>
    submitClickCard(db, { paymentId: req.params.id, number: req.body?.number, expiry: req.body?.expiry }, opts)));
  app.post('/api/payments/:id/click/confirm', run(req =>
    confirmClick(db, { paymentId: req.params.id, code: req.body?.code, lang: langOf(req) }, opts)));

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
