// Refunds (05 §8, §14; BR-11, BR-12, BR-14, BR-17): the automatic refund on a developer cancel, the manual one by the
// head only, the late Stripe payment through to refunded, a pending Stripe refund, a failed one and its retry.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import express from 'express';
import { fakeClock } from '../../server/core/clock.js';
import { createHold, cancel, sweepDue } from '../../server/core/bookings.js';
import { startPayment } from '../../server/core/payments.js';
import { requestRefund, refundManual, retryRefund, applyRefundResult, refundJobHandlers } from '../../server/core/refunds.js';
import { runDue } from '../../server/core/jobs.js';
import { context, inTx } from '../../server/core/tx.js';
import { submitCard, confirmCard } from '../../server/payments/card.js';
import { clickProvider } from '../../server/payments/click.js';
import { mountStripeWebhook } from '../../server/http/payments.js';
import { createTestDb, resetDb } from '../support/db.js';
import { makeStaff, asStaff } from '../support/factories.js';

const ENV = { LINK_SECRET: 'test-secret', TELEGRAM_STAFF_CHAT_ID: '-1', PUBLIC_URL: 'https://domus.test',
  STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_test_secret' };
const WEB = { type: 'client', id: null, role: 'client', channel: 'web' };

let db, server, base, stripe, manager, head;
const OPTS = { env: ENV, get stripe() { return stripe; } };

// Stripe: a session paid at once; refunds answer what the test sets.
function fakeStripe() {
  const s = { refund: { id: 're_1', status: 'succeeded' }, created: [], retrieved: 0 };
  s.checkout = { sessions: {
    create: async params => ({ id: 'cs_test_1', url: 'https://checkout.stripe.com/x', metadata: params.metadata }),
    retrieve: async id => ({ id, status: 'complete', payment_status: 'paid', payment_intent: 'pi_1' }),
    expire: async () => { throw new Error('Only open sessions can be expired'); }
  } };
  s.paymentIntents = { retrieve: async () => ({}) };
  s.refunds = {
    create: async (params, options) => { s.created.push({ params, options }); return { ...s.refund }; },
    retrieve: async () => { s.retrieved++; return { ...s.refund }; }
  };
  return s;
}

before(async () => {
  db = await createTestDb();
  const app = express();
  mountStripeWebhook(app, db, OPTS);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await db.close(); });
beforeEach(async () => {
  await resetDb(db);
  stripe = fakeStripe();
  fakeClock.set('2026-10-28T10:00:00+05:00');
  manager = asStaff(await makeStaff(db));
  head = asStaff(await makeStaff(db, { login: 'boss', name: 'Руководитель', role: 'head' }));
});
afterEach(() => fakeClock.reset());

async function hold(apartmentNo) {
  return (await createHold(db, { apartmentNo, client: { name: 'Аня', phone: `+9989012345${apartmentNo}` },
    consent: { version: '2026-10-27' }, channel: 'web' }, WEB, { env: ENV })).booking;
}
// A booking paid with the HUMO emulator. → { booking, paymentId }.
async function booked(apartmentNo = 41) {
  const booking = await hold(apartmentNo);
  const { paymentId } = await startPayment(db, { target: { bookingId: booking.id }, provider: 'card' }, WEB, { env: ENV });
  const { sms } = await submitCard(db, { paymentId, number: '9860 0000 0009 0001', expiry: '12/29' }, { env: ENV });
  assert.equal((await confirmCard(db, { paymentId, code: sms.code }, { env: ENV })).status, 'succeeded');
  return { booking: await db.one('SELECT * FROM bookings WHERE id = $1', [booking.id]), paymentId };
}
const pay = id => db.one('SELECT status FROM payments WHERE id = $1', [id]).then(r => r.status);
const refundOf = id => db.one('SELECT * FROM refunds WHERE payment_id = $1 ORDER BY created_at DESC LIMIT 1', [id]);
const run = () => runDue(db, refundJobHandlers(OPTS).handlers, { limit: 20 });
const templates = async () => (await db.query('SELECT template FROM outbox ORDER BY id')).map(o => o.template);
const rejects = (p, code) => assert.rejects(p, e => e.code === code);

test('developer cancel → automatic refund (BR-12): refund_due → the job → refunded, refund_done and staff_refund_done', async () => {
  const { booking, paymentId } = await booked();
  await cancel(db, { bookingId: booking.id, initiator: 'developer', reason: 'Квартира снята с продажи' }, manager, { env: ENV });
  assert.equal(await pay(paymentId), 'refund_due');
  const r = await refundOf(paymentId);
  assert.deepEqual([r.reason, r.status, Number(r.amount)], ['developer_cancel', 'pending', 10_000_000]);
  assert.deepEqual(await run(), { done: 1, skipped: 0, retried: 0, failed: 0 });
  const done = await refundOf(paymentId);
  assert.equal(done.status, 'succeeded');
  assert.match(done.provider_ref, /^rf_[0-9a-f]{12}$/);
  assert.ok(done.completed_at);
  assert.equal(await pay(paymentId), 'refunded');
  const t = await templates();
  assert.ok(t.includes('refund_done') && t.includes('staff_refund_done'));
  assert.ok(await db.one(`SELECT 1 FROM events WHERE type = 'refund.succeeded'`));
  const again = await inTx(db, context({ env: ENV }), (q, fx) => applyRefundResult(q, fx, context({ env: ENV }), r.id, 'failed'));
  assert.equal(again, null, 'the second of job and webhook changes nothing');
});

test('client cancel keeps the deposit (BR-11); the manual refund — the head only, a reason, a closed booking (BR-14)', async () => {
  const active = await booked(42);
  await rejects(refundManual(db, { paymentId: active.paymentId, reason: 'Просьба клиента' }, head, { env: ENV }), 'refund_not_allowed');

  const { booking, paymentId } = await booked(41);
  await cancel(db, { bookingId: booking.id, initiator: 'client', reason: 'Передумал' }, manager, { env: ENV });
  assert.equal(await pay(paymentId), 'succeeded', 'kept');
  assert.equal(await db.one('SELECT 1 FROM refunds WHERE payment_id = $1', [paymentId]), null);
  await rejects(refundManual(db, { paymentId, reason: 'Просьба клиента' }, manager, { env: ENV }), 'forbidden');
  await rejects(refundManual(db, { paymentId, reason: ' ' }, head, { env: ENV }), 'reason_required');
  const { refundId } = await refundManual(db, { paymentId, reason: 'Семейные обстоятельства' }, head, { env: ENV });
  const r = await db.one('SELECT * FROM refunds WHERE id = $1', [refundId]);
  assert.deepEqual([r.reason, r.note, r.requested_by.role], ['manual', 'Семейные обстоятельства', 'head']);
  await rejects(refundManual(db, { paymentId, reason: 'Ещё раз' }, head, { env: ENV }), 'refund_not_allowed');
  await run();
  assert.equal(await pay(paymentId), 'refunded');
});

test('an expired booking may be refunded by hand; a developer-cancelled one already was', async () => {
  const { booking, paymentId } = await booked();
  fakeClock.advance('73h');
  await sweepDue(db, { limit: 10 }, { env: ENV });
  assert.equal((await db.one('SELECT status FROM bookings WHERE id = $1', [booking.id])).status, 'expired');
  await refundManual(db, { paymentId, reason: 'Решение руководителя' }, head, { env: ENV });
  assert.equal(await pay(paymentId), 'refund_due');
});

test('late Stripe payment (FR-PAY-06): refund_due → refunds.create with the refund key → refunded; payment_late, refund_done', async () => {
  const b = await hold(41);
  const { paymentId } = await startPayment(db, { target: { bookingId: b.id }, provider: 'stripe' }, WEB, OPTS);
  await db.query(`UPDATE payments SET provider_amount = 1000000000 WHERE id = $1`, [paymentId]);
  fakeClock.advance('16m');
  await sweepDue(db, {}, OPTS);
  const payload = JSON.stringify({ id: 'evt_late', type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_1', payment_status: 'paid', status: 'complete', payment_intent: 'pi_1', metadata: { paymentId } } } });
  const res = await fetch(`${base}/api/payments/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json',
    'stripe-signature': Stripe.webhooks.generateTestHeaderString({ payload, secret: ENV.STRIPE_WEBHOOK_SECRET }) }, body: payload });
  assert.equal(res.status, 200);
  assert.equal(await pay(paymentId), 'refund_due');
  const r = await refundOf(paymentId);
  assert.equal(r.reason, 'late_payment');
  await run();
  const [{ params, options }] = stripe.created;
  assert.deepEqual([params.payment_intent, params.amount, params.reason, params.metadata.refundId],
    ['pi_1', 1_000_000_000, 'requested_by_customer', r.id]);
  assert.equal(options.idempotencyKey, `refund:${r.id}`);
  assert.equal(await pay(paymentId), 'refunded');
  assert.equal((await refundOf(paymentId)).provider_ref, 're_1');
  const t = await templates();
  assert.ok(t.includes('payment_late') && t.includes('refund_done'));
});

test('a pending Stripe refund is looked at again in a minute; the webhook refund.updated may finish it first', async () => {
  const b = await hold(41);
  const { paymentId } = await startPayment(db, { target: { bookingId: b.id }, provider: 'stripe' }, WEB, OPTS);
  await db.query(`UPDATE payments SET status = 'succeeded', provider_payment_ref = 'pi_1', provider_amount = 1000000000 WHERE id = $1`, [paymentId]);
  const r = await inTx(db, context(OPTS), (q, fx) => requestRefund(q, fx, context(OPTS), { paymentId, reason: 'developer_cancel' }));
  stripe.refund = { id: 're_9', status: 'pending' };
  await run();
  assert.equal((await refundOf(paymentId)).status, 'pending');
  assert.equal((await refundOf(paymentId)).provider_ref, 're_9');
  const next = await db.one(`SELECT run_at, payload FROM jobs WHERE type = 'refund.process' AND status = 'scheduled'`);
  assert.equal(next.payload.check, 1);
  assert.equal(next.run_at.getTime() - Date.parse('2026-10-28T10:00:00+05:00'), 60e3);

  const payload = JSON.stringify({ id: 'evt_rf', type: 'refund.updated', data: { object: { id: 're_9', status: 'succeeded', metadata: { refundId: r.id } } } });
  await fetch(`${base}/api/payments/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json',
    'stripe-signature': Stripe.webhooks.generateTestHeaderString({ payload, secret: ENV.STRIPE_WEBHOOK_SECRET }) }, body: payload });
  assert.equal(await pay(paymentId), 'refunded');
  fakeClock.advance('1m');
  assert.equal((await run()).skipped, 1, 'the check finds it done');
  assert.equal(stripe.retrieved, 0);
});

test('a failed refund: the payment stays refund_due, refund.failed; the head repeats it (retryRefund)', async () => {
  const b = await hold(41);
  const { paymentId } = await startPayment(db, { target: { bookingId: b.id }, provider: 'stripe' }, WEB, OPTS);
  await db.query(`UPDATE payments SET status = 'succeeded', provider_payment_ref = 'pi_1', provider_amount = 1000000000 WHERE id = $1`, [paymentId]);
  const r = await inTx(db, context(OPTS), (q, fx) => requestRefund(q, fx, context(OPTS), { paymentId, reason: 'developer_cancel' }));
  stripe.refund = { id: 're_2', status: 'failed', failure_reason: 'charge_for_pending_refund_disputed' };
  await run();
  const failed = await refundOf(paymentId);
  assert.deepEqual([failed.status, failed.failure], ['failed', 'charge_for_pending_refund_disputed']);
  assert.equal(await pay(paymentId), 'refund_due');
  assert.ok(await db.one(`SELECT 1 FROM events WHERE type = 'refund.failed'`));
  await rejects(retryRefund(db, { refundId: r.id }, manager, { env: ENV }), 'forbidden');
  stripe.refund = { id: 're_3', status: 'succeeded' };
  const { refundId } = await retryRefund(db, { refundId: r.id }, head, OPTS);
  assert.notEqual(refundId, r.id);
  await rejects(retryRefund(db, { refundId }, head, OPTS), 'refund_in_progress');
  await run();
  assert.equal(await pay(paymentId), 'refunded');
});

test('Click live: the refund is failed / manual_required (05 §8.4); the emulator refunds at once', async () => {
  const live = clickProvider({ CLICK_MODE: 'live', CLICK_SERVICE_ID: '1', CLICK_MERCHANT_ID: '2', CLICK_MERCHANT_USER_ID: '3', CLICK_SECRET_KEY: 's' });
  assert.deepEqual(await live.refund({}, {}), { status: 'failed', error: 'manual_required' });
  assert.equal((await clickProvider({}).refund({}, {})).status, 'succeeded');
});
