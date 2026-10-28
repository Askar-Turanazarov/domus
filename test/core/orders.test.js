// 03 §13, 05 §3.3, 12 §12.2 (D5-06, S): requests and furniture orders — the client by the rules of §9, the 30% prepayment
// (BR-21) from the order page /o/<no>-<sig> through the card emulator, the stage only forward with expectedVersion, the
// notifications order_prepaid / staff_order_prepaid / order_stage_changed, a cancelled order closes its open payment.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { fakeClock } from '../../server/core/clock.js';
import { createOrder, setStage, prepayOf, orderPath, confirmPrepaid } from '../../server/core/orders.js';
import { startPayment } from '../../server/core/payments.js';
import { render } from '../../server/notify/render.js';
import { mountPayments } from '../../server/http/payments.js';
import { mountOrders, mountAdminOrders } from '../../server/http/orders.js';
import { mountAdmin } from '../../server/http/admin.js';
import { hashPassword } from '../../server/adminAuth.js';
import { createStaff } from '../../server/core/staff.js';
import { requestId, apiErrors } from '../../server/http/common.js';
import { createTestDb, resetDb } from '../support/db.js';
import { makeBooking, asStaff } from '../support/factories.js';

const ENV = { LINK_SECRET: 'test-secret', SESSION_SECRET: 'x'.repeat(40), LOG_SALT: 'salt', PUBLIC_URL: 'https://x.test', TELEGRAM_STAFF_CHAT_ID: '-100' };
const core = { env: ENV, render: (tpl, lang, vars) => render(tpl, lang, vars, { publicUrl: ENV.PUBLIC_URL }) };
const PASSWORD = 'orders test password 1';
const OFFER = '2026-10-27';
const HUMO_OK = '9860 0000 0009 0001';
let db, server, base, cookie, staff;

before(async () => {
  db = await createTestDb();
  const app = express();
  app.use(requestId);
  app.use(express.json());
  mountOrders(app, db, core);
  mountPayments(app, db, core);
  const staffAuth = mountAdmin(app, db, { env: ENV, cacheMs: 0 });
  mountAdminOrders(app, db, staffAuth, core);
  app.use(apiErrors);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); return db.close(); });
beforeEach(async () => {
  await resetDb(db);
  fakeClock.set('2026-10-28T10:00:00+05:00');
  staff = await createStaff(db, { login: 'o-manager', name: 'Азиз', role: 'manager', passwordHash: await hashPassword(PASSWORD) });
  const res = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'domus-admin' },
    body: JSON.stringify({ login: 'o-manager', password: PASSWORD }) });
  cookie = res.headers.get('set-cookie').split(';')[0];
});
afterEach(() => fakeClock.reset());

const furniture = (over = {}) => ({ name: 'Аня', phone: '+998 90 123 45 67', comment: 'Кухня к Новому году', lang: 'ru',
  project: { name: 'Моя кухня' }, estimate: 12_345_678,
  rooms: [{ name: 'Кухня', items: [{ name: 'Шкаф', type: 'wardrobe' }, { name: 'Стол', type: 'table' }] }], ...over });
const call = async (method, path, { body, key, admin = false } = {}) => {
  const r = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'Content-Type': 'application/json',
    ...(admin ? { 'X-Requested-With': 'domus-admin', Cookie: cookie } : {}), ...(key ? { 'Idempotency-Key': key } : {}) } });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const rows = async tpl => (await db.query('SELECT vars, rendered, client_id FROM outbox WHERE template = $1 ORDER BY id', [tpl]))
  .map(r => ({ ...r, rendered: { ...r.rendered, text: r.rendered.text.replace(/\s/g, ' ') } }));
const refOf = link => link.slice('/o/'.length);

async function payByCard(paymentId) {
  const sms = await call('POST', `/api/payments/${paymentId}/card`, { body: { number: HUMO_OK, expiry: '12/29' } });
  assert.equal(sms.status, 200, JSON.stringify(sms.body));
  return call('POST', `/api/payments/${paymentId}/card/confirm`, { body: { code: sms.body.sms.code, lang: 'ru' } });
}

test('BR-21: the prepayment is 30% of the estimate rounded to 1000; nothing without an estimate', () => {
  assert.equal(prepayOf(12_345_678, 30), 3_704_000);
  assert.equal(prepayOf(1_000_000, 30), 300_000);
  assert.equal(prepayOf(null, 30), null);
  assert.equal(prepayOf(0, 30), null);
});

test('a furniture order: the client by the rules of §9, the prepayment, order.created and the page link; a request for an apartment goes to the group', async () => {
  const a = await createOrder(db, { order: furniture(), files: [['plan.png', Buffer.from('png')]], ip: '1.2.3.4' }, core);
  assert.equal(a.kind, 'furniture');
  assert.equal(a.link, orderPath({ no: a.no, id: a.id }, ENV));
  const o = await db.one('SELECT * FROM orders WHERE id = $1', [a.id]);
  assert.deepEqual([o.stage, Number(o.estimate), Number(o.prepay_amount), o.booking_id], ['new', 12_345_678, 3_704_000, null]);
  assert.equal(o.doc.name, undefined, 'the name stays in the client card');
  const ev = await db.one(`SELECT data, order_id FROM events WHERE type = 'order.created'`);
  assert.deepEqual(ev.data, { kind: 'furniture', estimate: 12_345_678 });
  const again = await createOrder(db, { order: furniture({ estimate: 2_000_000 }) }, core);
  const clients = await db.query('SELECT DISTINCT client_id FROM orders');
  assert.equal(clients.length, 1, 'the same phone and name — the same client card (R4)');

  const req = await createOrder(db, { order: { name: 'Борис', phone: '+998 91 000 00 01', comment: 'Хочу посмотреть', lang: 'ru',
    project: { name: '' }, estimate: 900_000_000, apartmentRef: { building: 'chinor-park', floor: 4, apt: 41 } } }, core);
  assert.deepEqual([req.kind, req.link], ['apartment_request', null]);
  const [ping] = await rows('staff_new_request');
  assert.match(ping.rendered.text, /Заявка на квартиру №41/);
  assert.equal(again.kind, 'furniture');
});

test('FR-FURN-01: a furniture order for an apartment the client has a booking of is tied to it', async () => {
  const first = await createOrder(db, { order: furniture() }, core);
  const { client_id: clientId } = await db.one('SELECT client_id FROM orders WHERE id = $1', [first.id]);
  const b = await makeBooking(db, { apartmentNo: 41, clientId, status: 'booked', minutes: 72 * 60 });
  const tied = await createOrder(db, { order: furniture({ apartmentRef: { building: 'chinor-park', floor: 4, apt: 41 } }) }, core);
  assert.equal((await db.one('SELECT booking_id, kind FROM orders WHERE id = $1', [tied.id])).booking_id, b.id);
});

test('the order page and the prepayment by card: consent, order_prepaid with the button, staff_order_prepaid, stage accepted; a second payment is refused', async () => {
  const o = await createOrder(db, { order: furniture() }, core);
  const ref = refOf(o.link);
  const page = await call('GET', `/api/orders/by-ref/${ref}`);
  assert.equal(page.status, 200);
  assert.deepEqual([page.body.order.prepayAmount, page.body.order.stage, page.body.prepayPct, page.body.payment], [3_704_000, 'new', 30, null]);
  assert.deepEqual(page.body.order.rooms, [{ name: 'Кухня', items: ['Шкаф', 'Стол'] }]);
  assert.ok(!JSON.stringify(page.body).includes('Аня') && !JSON.stringify(page.body).includes('45 67'), 'no name, no phone');
  assert.equal((await call('GET', `/api/orders/by-ref/${o.no}-${'A'.repeat(32)}`)).body.error, 'link_invalid');

  const noConsent = await call('POST', '/api/payments', { body: { ref: `o:${ref}`, provider: 'card' }, key: 'order-pay-0001' });
  assert.equal(noConsent.body.error, 'consent_required');
  const start = await call('POST', '/api/payments', { body: { ref: `o:${ref}`, provider: 'card', consent: { version: OFFER } }, key: 'order-pay-0002' });
  assert.equal(start.status, 201, JSON.stringify(start.body));
  const p = await db.one('SELECT * FROM payments WHERE id = $1', [start.body.paymentId]);
  assert.deepEqual([p.kind, Number(p.amount), p.expires_at.toISOString()], ['furniture_prepay', 3_704_000, '2026-10-28T05:30:00.000Z']);

  const done = await payByCard(p.id);
  assert.equal(done.body.status, 'succeeded');
  assert.equal(done.body.redirect, `${o.link}?paid=1`);
  const row = await db.one('SELECT * FROM orders WHERE id = $1', [o.id]);
  assert.deepEqual([row.stage, row.prepaid_at?.toISOString(), row.consent_version], ['accepted', '2026-10-28T05:00:00.000Z', OFFER]);
  const ev = await db.one(`SELECT data, payment_id FROM events WHERE type = 'order.prepaid'`);
  assert.deepEqual([ev.data, ev.payment_id], [{ amount: 3_704_000 }, p.id]);
  const [toClient] = await rows('order_prepaid');
  assert.match(toClient.rendered.text, /Предоплата 3 704 000 сум по заказу мебели №\d+ получена/);
  assert.match(JSON.stringify(toClient.rendered.reply_markup), /Мой заказ/);
  assert.match((await rows('staff_order_prepaid'))[0].rendered.text, /🛋 Предоплата 3 704 000 сум/);

  const view = await call('GET', `/api/orders/by-ref/${ref}`);
  assert.equal(view.body.order.prepaidAt, '2026-10-28T05:00:00.000Z');
  assert.equal((await call('GET', `/api/payments/${p.id}`)).body.target.type, 'order');
  const twice = await call('POST', '/api/payments', { body: { ref: `o:${ref}`, provider: 'card' }, key: 'order-pay-0003' });
  assert.equal(twice.body.error, 'order_already_paid');
});

test('an order payment lives 30 min; a duplicate prepayment goes back as refund_due', async () => {
  const o = await createOrder(db, { order: furniture() }, core);
  const { paymentId } = await startPayment(db, { target: { orderId: o.id }, provider: 'card', consent: { version: OFFER } },
    { type: 'client', id: null, role: 'client', channel: 'web' }, core);
  fakeClock.advance('31m');
  const sms = await call('POST', `/api/payments/${paymentId}/card`, { body: { number: HUMO_OK, expiry: '12/29' } });
  assert.equal(sms.status, 409);
  assert.equal((await db.one('SELECT failure_reason FROM payments WHERE id = $1', [paymentId])).failure_reason, 'session_expired');

  const p = await db.one(`INSERT INTO payments (code, kind, order_id, client_id, provider, amount, currency, provider_amount, status, expires_at,
      created_by, created_at, updated_at) SELECT 'P-ZZZZ', 'furniture_prepay', id, client_id, 'card', prepay_amount, 'UZS', prepay_amount,
      'processing', $2, '{}', $3, $3 FROM orders WHERE id = $1 RETURNING *`, [o.id, new Date('2026-10-28T06:30:00Z'), new Date('2026-10-28T05:31:00Z')]);
  await db.query(`UPDATE orders SET prepaid_at = $2 WHERE id = $1`, [o.id, new Date('2026-10-28T05:31:00Z')]);
  const r = await db.tx(q => confirmPrepaid(q, { outbox: [], jobs: [] }, { now: () => new Date(), env: ENV }, { orderId: o.id, payment: p }));
  assert.equal(r, 'duplicate');
});

test('the stage only forward with expectedVersion; order_stage_changed to the client; a cancelled order closes its open payment', async () => {
  const o = await createOrder(db, { order: furniture() }, core);
  await startPayment(db, { target: { orderId: o.id }, provider: 'card', consent: { version: OFFER } },
    { type: 'client', id: null, role: 'client', channel: 'web' }, core);
  const me = asStaff(staff);
  await assert.rejects(setStage(db, { orderId: o.id, stage: 'production', expectedVersion: 1 }, me, core), /stage_invalid/, 'not over a stage');
  const list = await call('GET', '/api/admin/orders?kind=furniture', { admin: true });
  assert.equal(list.status, 200);
  const item = list.body.items[0];
  assert.deepEqual([item.no, item.next, item.prepayAmount, item.payment.status, item.phone], [o.no, 'accepted', 3_704_000, 'pending', '+998 90 *** ** 67']);

  const unpaid = await call('POST', `/api/admin/orders/${o.id}/stage`, { body: { stage: 'accepted', expectedVersion: item.version }, key: 'stage-key-0005', admin: true });
  assert.deepEqual([unpaid.status, unpaid.body.error], [409, 'prepay_required'], 'a manager does not accept an unpaid order');
  await db.query('UPDATE orders SET prepaid_at = $2 WHERE id = $1', [o.id, new Date('2026-10-28T05:40:00Z')]);
  const moved = await call('POST', `/api/admin/orders/${o.id}/stage`, { body: { stage: 'accepted', expectedVersion: item.version }, key: 'stage-key-0001', admin: true });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual([moved.body.order.stage, moved.body.order.next], ['accepted', 'production']);
  const repeat = await call('POST', `/api/admin/orders/${o.id}/stage`, { body: { stage: 'accepted', expectedVersion: item.version }, key: 'stage-key-0001', admin: true });
  assert.deepEqual(repeat.body, moved.body, 'a double click moves once');
  const stale = await call('POST', `/api/admin/orders/${o.id}/stage`, { body: { stage: 'production', expectedVersion: item.version }, key: 'stage-key-0002', admin: true });
  assert.equal(stale.body.error, 'stale');
  const [msg] = await rows('order_stage_changed');
  assert.match(msg.rendered.text, /Заказ мебели №\d+: принят в работу\./);
  const ev = await db.one(`SELECT data, staff_id FROM events WHERE type = 'order.stage_changed'`);
  assert.deepEqual([ev.data, ev.staff_id], [{ from: 'new', to: 'accepted' }, staff.id]);

  const cancel = await call('POST', `/api/admin/orders/${o.no}/stage`, { body: { stage: 'cancelled', expectedVersion: moved.body.order.version }, key: 'stage-key-0003', admin: true });
  assert.equal(cancel.body.order.stage, 'cancelled');
  assert.equal((await db.one('SELECT status, failure_reason FROM payments WHERE order_id = $1', [o.id])).failure_reason, 'order_closed');
  assert.equal((await call('POST', `/api/admin/orders/${o.id}/stage`, { body: { stage: 'cancelled', expectedVersion: cancel.body.order.version }, key: 'stage-key-0004', admin: true })).body.error, 'stage_invalid');
  const page = await call('GET', `/api/orders/by-ref/${refOf(o.link)}`);
  assert.equal(page.body.order.stage, 'cancelled');
  const pay = await call('POST', '/api/payments', { body: { ref: `o:${refOf(o.link)}`, provider: 'card', consent: { version: OFFER } }, key: 'order-pay-0009' });
  assert.equal(pay.body.error, 'order_already_paid', 'a paid and cancelled order is not paid again');
});

test('the admin card, the files and the note', async () => {
  const o = await createOrder(db, { order: furniture(), files: [['plan.png', Buffer.from('PNGDATA')]] }, core);
  const card = await call('GET', `/api/admin/orders/${o.no}`, { admin: true });
  assert.deepEqual([card.body.files, card.body.doc.project.name], [['plan.png'], 'Моя кухня']);
  const f = await fetch(`${base}/api/admin/orders/${o.id}/plan.png`, { headers: { Cookie: cookie } });
  assert.deepEqual([f.status, Buffer.from(await f.arrayBuffer()).toString()], [200, 'PNGDATA']);
  assert.equal((await fetch(`${base}/api/admin/orders/${o.id}/secret.txt`, { headers: { Cookie: cookie } })).status, 404);
  const n = await call('PATCH', `/api/admin/orders/${o.id}`, { body: { note: 'Перезвонить в пятницу' }, admin: true });
  assert.equal(n.body.order.note, 'Перезвонить в пятницу');
  assert.equal((await call('GET', '/api/admin/orders')).status, 401, 'staff only');
});

test('the head accepts an unpaid order by hand', async () => {
  const o = await createOrder(db, { order: furniture() }, core);
  const head = asStaff(await createStaff(db, { login: 'o-head', name: 'Нигора', role: 'head', passwordHash: await hashPassword(PASSWORD) }));
  const row = await setStage(db, { orderId: o.id, stage: 'accepted', expectedVersion: 1 }, head, core);
  assert.deepEqual([row.stage, row.prepaid_at], ['accepted', null]);
});
