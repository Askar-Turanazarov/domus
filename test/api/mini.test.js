// /mini and /api/mini/* (10 §7, 11 §8, 13 §7): a forged or missing initData → 401 tg_auth_failed; the client is the
// Telegram user (R1), channel 'mini'; the hold takes the phone from the card or the body; a payment only for one's own booking.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { fakeClock, now as clockNow } from '../../server/core/clock.js';
import { requestId, noStore, apiErrors } from '../../server/http/common.js';
import { mountBookings } from '../../server/http/bookings.js';
import { mountPayments } from '../../server/http/payments.js';
import { mountMini, miniPage } from '../../server/http/mini.js';
import { signInitData } from '../../server/telegram/initData.js';
import { createTestDb, resetDb } from '../support/db.js';
import { ENV } from '../support/api.js';

const TOKEN = '123456:TEST';
const MINI_ENV = { ...ENV, TELEGRAM_BOT_TOKEN: TOKEN };
const CONSENT = { version: '2026-10-27', privacy: true };
const BUILDING = { id: 'chinor', floors: 9 };
let db, server, base;

before(async () => {
  db = await createTestDb();
  const app = express();
  app.use(requestId);
  app.use('/api', noStore);
  const opts = { env: MINI_ENV };
  mountBookings(app, db, opts);
  mountPayments(app, db, opts);
  mountMini(app, db, { ...opts, buildings: { get: async id => (id === 'chinor' ? BUILDING : null) }, buildingId: 'chinor' });
  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));
  app.use(apiErrors);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await db.close(); });
beforeEach(async () => { await resetDb(db); fakeClock.set('2026-10-28T10:00:00+05:00'); });
afterEach(() => fakeClock.reset());

const initData = (user = { id: 77, first_name: 'Аня', username: 'anya', language_code: 'uz' }, at = clockNow()) =>
  signInitData({ auth_date: String(Math.floor(at.getTime() / 1000)), query_id: 'q1', user }, TOKEN);

async function call(method, url, body, { tg = initData(), headers = {} } = {}) {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(tg ? { 'x-tg-init-data': tg } : {}),
    ...(method === 'POST' ? { 'idempotency-key': crypto.randomUUID() } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* HTML */ }
  return { status: r.status, body: json, text, headers: r.headers };
}

test('no, forged, foreign-token or stale initData → 401 tg_auth_failed on every /api/mini entry; nothing is created', async () => {
  const p = new URLSearchParams(initData());
  p.set('user', JSON.stringify({ id: 78, first_name: 'Чужой' }));
  const stale = initData(undefined, new Date(clockNow().getTime() - 25 * 3600e3));
  const foreign = signInitData({ auth_date: String(Math.floor(clockNow().getTime() / 1000)), user: { id: 77, first_name: 'А' } }, '999:OTHER');
  for (const tg of [null, 'hash=00', p.toString(), stale, foreign]) {
    for (const [m, u, b] of [['GET', '/api/mini/bootstrap'], ['GET', '/api/mini/bookings'],
      ['POST', '/api/mini/bookings/hold', { apartmentNo: 41, phone: '+998901234567', consent: CONSENT }], ['POST', '/api/mini/payments', { ref: '1001-x', provider: 'card' }]]) {
      const r = await call(m, u, b, { tg });
      assert.deepEqual([r.status, r.body?.error], [401, 'tg_auth_failed'], `${m} ${u} with ${String(tg).slice(0, 20)}`);
    }
  }
  assert.equal((await db.one('SELECT count(*)::int AS n FROM clients')).n, 0);
  assert.equal((await db.one('SELECT count(*)::int AS n FROM bookings')).n, 0);
});

test('bootstrap: the building, the statuses, the card of the Telegram user (R1, channel mini), the terms', async () => {
  const r = await call('GET', '/api/mini/bootstrap');
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.building, BUILDING);
  assert.equal(r.body.statuses[41], 'free');
  assert.deepEqual(r.body.client, { name: 'Аня', lang: 'uz', phoneKnown: false });
  assert.deepEqual([r.body.bookings, r.body.mine], [[], {}]);
  assert.equal(r.body.terms.offerVersion, '2026-10-27');
  const c = await db.one('SELECT * FROM clients');
  assert.equal(Number(c.telegram_user_id), 77);
  assert.equal(c.telegram_username, 'anya');
  assert.deepEqual(c.channels, ['mini']);
  await call('GET', '/api/mini/bookings');
  assert.equal((await db.one('SELECT count(*)::int AS n FROM clients')).n, 1, 'the same user is the same card');
});

test('hold: the phone is required once, then taken from the card; channel mini; no cookie; the booking shows in «Мои брони»', async () => {
  const none = await call('POST', '/api/mini/bookings/hold', { apartmentNo: 41, consent: CONSENT });
  assert.deepEqual([none.status, none.body.fields], [400, ['phone']]);
  const noConsent = await call('POST', '/api/mini/bookings/hold', { apartmentNo: 41, phone: '+998 90 123 45 67' });
  assert.equal(noConsent.body.error, 'consent_required');
  const r = await call('POST', '/api/mini/bookings/hold', { apartmentNo: 41, phone: '+998 90 123 45 67', consent: CONSENT, website: '', openedAt: 1 });
  assert.equal(r.status, 201, r.text);
  assert.match(r.body.link, /^\/b\/1001-/);
  assert.equal(r.headers.get('set-cookie'), null);
  const b = await db.one('SELECT b.channel, c.phone, c.telegram_user_id FROM bookings b JOIN clients c ON c.id = b.client_id');
  assert.deepEqual([b.channel, b.phone, Number(b.telegram_user_id)], ['mini', '+998901234567', 77]);

  const boot = await call('GET', '/api/mini/bootstrap');
  assert.equal(boot.body.client.phoneKnown, true);
  assert.equal(boot.body.mine[41].link, r.body.link);
  const list = await call('GET', '/api/mini/bookings');
  assert.deepEqual(list.body.items.map(i => [i.no, i.apartmentNo, i.status, i.link]), [[1001, 41, 'held', r.body.link]]);

  const again = await call('POST', '/api/mini/bookings/hold', { apartmentNo: 42, consent: CONSENT });
  assert.equal(again.status, 201, 'the phone comes from the card now');
});

test('payment: one\'s own booking starts; someone else\'s link answers link_invalid (404)', async () => {
  const mine = await call('POST', '/api/mini/bookings/hold', { apartmentNo: 41, phone: '+998901234567', consent: CONSENT });
  const ref = mine.body.link.replace('/b/', '');
  const other = initData({ id: 88, first_name: 'Борис' });
  const foreign = await call('POST', '/api/mini/payments', { ref, provider: 'card' }, { tg: other });
  assert.deepEqual([foreign.status, foreign.body.error], [404, 'link_invalid']);
  const pay = await call('POST', '/api/mini/payments', { ref, provider: 'card' });
  assert.equal(pay.status, 201, pay.text);
  assert.ok(pay.body.url);
  assert.equal((await db.one("SELECT count(*)::int AS n FROM payments WHERE status IN ('created', 'pending')")).n, 1);
});

test('/mini: the showcase with data-mode="mini", the Telegram script, mini.js of the page; framed by telegram.org only; not indexed', async () => {
  const r = await call('GET', '/mini', undefined, { tg: null });
  assert.equal(r.status, 200);
  assert.match(r.text, /<html[^>]*data-mode="mini"/);
  assert.match(r.text, /<script src="https:\/\/telegram\.org\/js\/telegram-web-app\.js"><\/script>/);
  assert.match(r.text, /src="\/js\/mini\.js"/);
  assert.equal(r.headers.get('x-frame-options'), null);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors https:\/\/web\.telegram\.org/);
  assert.match(r.headers.get('x-robots-tag'), /noindex/);
  assert.equal(miniPage('<html lang="ru" data-mode="x"><head></head>'), '<html lang="ru" data-mode="mini"><head>  <script src="https://telegram.org/js/telegram-web-app.js"></script>\n</head>');
});
