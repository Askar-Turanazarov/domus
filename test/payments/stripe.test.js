// Stripe Checkout (05 §6, §14): the money of D-05, the session, the webhook with the raw body and the real signature
// (a bad one → 400, a repeat → no change, DoD-4), the late payment (§6.7), the return page (§6.5), the reconcile job.
// The Stripe API is a fake client; the signature is made and checked by the real library.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Stripe from 'stripe';
import { fakeClock, now } from '../../server/core/clock.js';
import { createHold, sweepDue } from '../../server/core/bookings.js';
import { startPayment, paymentJobHandlers } from '../../server/core/payments.js';
import { runDue } from '../../server/core/jobs.js';
import { mountPayments, mountStripeWebhook } from '../../server/http/payments.js';
import { stripeConfig, stripeMoney, stripeProvider } from '../../server/payments/stripe.js';
import { createTestDb, resetDb } from '../support/db.js';

const ENV = { LINK_SECRET: 'test-secret', PUBLIC_URL: 'https://domus.test', STRIPE_SECRET_KEY: 'sk_test_fake',
  STRIPE_WEBHOOK_SECRET: 'whsec_test_secret' };
const WEB = { type: 'client', id: null, role: 'client', channel: 'web' };

// The part of the Stripe API we use, in memory.
function fakeStripe() {
  const sessions = new Map();
  const calls = [];
  let n = 0;
  const get = id => {
    if (!sessions.has(id)) throw new Error('No such checkout.session');
    return { ...sessions.get(id) };
  };
  return {
    calls, sessions,
    pay: id => Object.assign(sessions.get(id), { status: 'complete', payment_status: 'paid', payment_intent: `pi_${id}` }),
    checkout: { sessions: {
      create: async (params, options) => {
        calls.push({ params, options });
        const id = `cs_test_${++n}`;
        sessions.set(id, { id, url: `https://checkout.stripe.com/c/pay/${id}`, status: 'open', payment_status: 'unpaid',
          payment_intent: null, metadata: params.metadata, client_reference_id: params.client_reference_id });
        return get(id);
      },
      retrieve: async id => get(id),
      expire: async id => {
        const s = sessions.get(id);
        if (s.status !== 'open') throw new Error('Only open sessions can be expired');
        s.status = 'expired';
        return get(id);
      }
    } },
    paymentIntents: { retrieve: async () => ({ latest_charge: { payment_method_details: { card: { brand: 'visa', last4: '4242' } } } }) },
    refunds: { create: async () => ({ id: 're_1', status: 'succeeded' }), retrieve: async () => ({ id: 're_1', status: 'succeeded' }) }
  };
}

let db, server, base, stripe, OPTS;
before(async () => {
  db = await createTestDb();
  const app = express();
  OPTS = { env: ENV, get stripe() { return stripe; } };
  mountStripeWebhook(app, db, OPTS);
  app.use(express.json());                                  // as in server.js: the global parser comes after the webhook
  mountPayments(app, db, OPTS);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await db.close(); });
beforeEach(async () => {
  await resetDb(db);
  stripe = fakeStripe();
  fakeClock.set('2026-10-28T10:00:00+05:00');
});
afterEach(() => fakeClock.reset());

async function pay(apartmentNo = 41, lang = 'ru') {
  const { booking } = await createHold(db, { apartmentNo, client: { name: 'Аня', phone: `+9989012345${apartmentNo}` },
    consent: { version: '2026-10-27' }, channel: 'web' }, WEB, { env: ENV });
  const r = await startPayment(db, { target: { bookingId: booking.id }, provider: 'stripe', lang }, WEB, OPTS);
  return { booking, r, payment: await row(r.paymentId) };
}
const row = id => db.one('SELECT * FROM payments WHERE id = $1', [id]);
const bookingStatus = async id => (await db.one('SELECT status FROM bookings WHERE id = $1', [id])).status;

let evt = 0;
function event(type, session, id = `evt_${++evt}`) {
  return JSON.stringify({ id, object: 'event', type, data: { object: session } });
}
async function hook(payload, secret = ENV.STRIPE_WEBHOOK_SECRET) {
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  const r = await fetch(`${base}/api/payments/stripe/webhook`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature }, body: payload });
  return { status: r.status, body: await r.json() };
}

test('money (D-05): uzs ×100, usd by the training rate; a live key or no webhook secret → off', () => {
  assert.deepEqual(stripeMoney(10_000_000, stripeConfig(ENV)), { currency: 'UZS', providerAmount: 1_000_000_000 });
  assert.deepEqual(stripeMoney(10_000_000, stripeConfig({ ...ENV, STRIPE_CURRENCY: 'usd', STRIPE_USD_RATE: '12700' })),
    { currency: 'USD', providerAmount: 78740 });
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    assert.equal(stripeProvider({ ...ENV, STRIPE_SECRET_KEY: 'sk_live_x' }).enabled(), false);
  } finally { console.error = orig; }
  assert.ok(errors.some(e => e.includes('sk_live_')));
  assert.equal(stripeProvider({ ...ENV, STRIPE_WEBHOOK_SECRET: '' }).enabled(), false);
  assert.equal(stripeProvider({ ...ENV, STRIPE_CURRENCY: 'usd' }).enabled(), false, 'usd without a rate');
  assert.equal(stripeProvider(ENV).enabled(), true);
});

test('begin: a card-only Checkout session for 1 000 000 000 uzs, 31 minutes, the session id kept', async () => {
  const { booking, r, payment } = await pay(41, 'uz');
  const { params, options } = stripe.calls[0];
  assert.deepEqual(params.payment_method_types, ['card']);
  assert.deepEqual([params.line_items[0].price_data.currency, params.line_items[0].price_data.unit_amount], ['uzs', 1_000_000_000]);
  assert.equal(params.locale, 'auto');
  assert.match(params.line_items[0].price_data.product_data.name, /№41/);
  assert.equal(params.metadata.paymentId, payment.id);
  assert.equal(params.metadata.bookingNo, String(booking.no));
  assert.equal(params.expires_at, Math.floor(now().getTime() / 1000) + 31 * 60);
  assert.equal(params.success_url, `https://domus.test/pay/return?payment=${payment.id}&session_id={CHECKOUT_SESSION_ID}`);
  assert.equal(options.idempotencyKey, `checkout:${payment.id}`);
  assert.equal(JSON.stringify(params).includes('+99890'), false, 'no name or phone goes to Stripe');
  assert.equal(r.url, 'https://checkout.stripe.com/c/pay/cs_test_1');
  assert.equal(payment.provider_ref, 'cs_test_1');
  assert.equal(Number(payment.provider_amount), 1_000_000_000);
});

test('webhook: a bad signature → 400 and nothing changes', async () => {
  const { payment } = await pay();
  stripe.pay(payment.provider_ref);
  const payload = event('checkout.session.completed', stripe.sessions.get(payment.provider_ref));
  const r = await hook(payload, 'whsec_wrong');
  assert.deepEqual([r.status, r.body.error], [400, 'stripe_signature_invalid']);
  const forged = await fetch(`${base}/api/payments/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
  assert.equal(forged.status, 400);
  assert.equal((await row(payment.id)).status, 'pending');
  assert.equal((await db.one('SELECT count(*)::int AS n FROM provider_events')).n, 0);
});

test('webhook: completed → booking with the card; the same event again → duplicate, no change (DoD-4)', async () => {
  const { booking, payment } = await pay();
  stripe.pay(payment.provider_ref);
  const payload = event('checkout.session.completed', stripe.sessions.get(payment.provider_ref), 'evt_paid');
  const r = await hook(payload);
  assert.deepEqual([r.status, r.body], [200, { received: true }]);
  assert.equal(await bookingStatus(booking.id), 'booked');
  const p = await row(payment.id);
  assert.deepEqual([p.status, p.provider_payment_ref, p.card_brand, p.card_mask], ['succeeded', `pi_${payment.provider_ref}`, 'VISA', '•••• 4242']);
  const again = await hook(payload);
  assert.deepEqual([again.status, again.body], [200, { duplicate: true }]);
  assert.equal((await row(payment.id)).version, p.version);
  assert.deepEqual(await db.one(`SELECT result, payment_id FROM provider_events WHERE event_id = 'evt_paid'`),
    { result: 'booked', payment_id: payment.id });
});

test('webhook: expired → cancelled / session_expired; async failed → bank_declined; others → ignored', async () => {
  const a = await pay(41);
  await hook(event('checkout.session.expired', { ...stripe.sessions.get(a.payment.provider_ref), status: 'expired' }));
  assert.deepEqual(await db.one('SELECT status, failure_reason FROM payments WHERE id = $1', [a.payment.id]),
    { status: 'cancelled', failure_reason: 'session_expired' });
  const b = await pay(42);
  await hook(event('checkout.session.async_payment_failed', stripe.sessions.get(b.payment.provider_ref)));
  assert.equal((await row(b.payment.id)).failure_reason, 'bank_declined');
  const other = await hook(event('customer.created', { id: 'cus_1' }, 'evt_other'));
  assert.equal(other.status, 200);
  assert.equal((await db.one(`SELECT result FROM provider_events WHERE event_id = 'evt_other'`)).result, 'ignored');
});

test('late payment (§6.7): the hold closed, Stripe still paid → refund_due and a late_payment refund', async () => {
  const { booking, payment } = await pay();
  fakeClock.advance('16m');
  await sweepDue(db, {}, OPTS);
  assert.deepEqual([(await row(payment.id)).status, (await row(payment.id)).failure_reason], ['cancelled', 'hold_expired']);
  stripe.pay(payment.provider_ref);
  await hook(event('checkout.session.completed', stripe.sessions.get(payment.provider_ref)));
  assert.equal((await row(payment.id)).status, 'refund_due');
  assert.notEqual(await bookingStatus(booking.id), 'booked');
  const refund = await db.one('SELECT reason, status, amount FROM refunds WHERE payment_id = $1', [payment.id]);
  assert.deepEqual([refund.reason, refund.status, Number(refund.amount)], ['late_payment', 'pending', 10_000_000]);
  assert.ok(await db.one(`SELECT 1 FROM outbox WHERE template = 'payment_late'`));
});

test('payment.reconcile: a cancelled Stripe payment — the open session is expired; a paid one is taken as late', async () => {
  const { handlers } = paymentJobHandlers(OPTS);
  const a = await pay(41);
  fakeClock.advance('16m');
  await sweepDue(db, {}, OPTS);
  assert.equal((await runDue(db, handlers)).done >= 1, true);
  assert.equal(stripe.sessions.get(a.payment.provider_ref).status, 'expired');
  assert.equal((await row(a.payment.id)).status, 'cancelled');

  fakeClock.set('2026-10-28T12:00:00+05:00');
  const b = await pay(42);
  fakeClock.advance('16m');
  await sweepDue(db, {}, OPTS);
  stripe.pay(b.payment.provider_ref);                       // paid between our cancel and the job
  await runDue(db, handlers);
  assert.equal((await row(b.payment.id)).status, 'refund_due');
});

test('GET /pay/return: paid → the booking with ?paid=1 even before the webhook; cancelled=1 → cancelled_by_user', async () => {
  const a = await pay(41);
  stripe.pay(a.payment.provider_ref);
  const r = await fetch(`${base}/pay/return?payment=${a.payment.id}&session_id=${a.payment.provider_ref}`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /^\/b\/\d+-[\w-]{32}\?paid=1$/);
  assert.equal(await bookingStatus(a.booking.id), 'booked');

  const b = await pay(42);
  const c = await fetch(`${base}/pay/return?payment=${b.payment.id}&cancelled=1`, { redirect: 'manual' });
  assert.equal(c.status, 302);
  assert.doesNotMatch(c.headers.get('location'), /paid/);
  assert.deepEqual([(await row(b.payment.id)).status, (await row(b.payment.id)).failure_reason], ['cancelled', 'cancelled_by_user']);
  assert.equal(stripe.sessions.get(b.payment.provider_ref).status, 'expired');
  assert.equal((await fetch(`${base}/pay/return?payment=nope`, { redirect: 'manual' })).status, 404);
});
