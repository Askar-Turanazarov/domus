// 12 §9, 13 §10, D-26: the dashboard over HTTP with the real staff gate — the periods by Tashkent days, the tiles (sold, in booking, deposits net of refunds,
// free, burning in 24 h), the funnel by cohorts, the charts with zero days, the feed; and a manager who gets counts and no money anywhere.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { fakeClock, now } from '../../server/core/clock.js';
import { hashPassword } from '../../server/adminAuth.js';
import { createStaff } from '../../server/core/staff.js';
import { mountAdmin } from '../../server/http/admin.js';
import { mountAdminDashboard } from '../../server/http/adminDashboard.js';
import { requestId, apiErrors } from '../../server/http/common.js';
import { createTestDb, resetDb } from '../support/db.js';
import { makeClient } from '../support/factories.js';

const PASSWORD = 'dash test password 1';
const ENV = { LINK_SECRET: 'test-secret', SESSION_SECRET: 'x'.repeat(40), LOG_SALT: 'salt', GEMINI_API_KEY: 'k' };
const MIN = 60e3, HOUR = 3600e3, DAY = 24 * HOUR;
let db, server, base, cookies, staff;

before(async () => {
  db = await createTestDb();
  const app = express();
  app.use(requestId);
  const staffAuth = mountAdmin(app, db, { env: ENV, cacheMs: 0 });
  mountAdminDashboard(app, db, { env: ENV, cacheMs: 0 });
  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));
  app.use(apiErrors);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  void staffAuth;
});
after(() => { server.close(); return db.close(); });

beforeEach(async () => {
  await resetDb(db);
  fakeClock.set('2026-10-28T10:00:00+05:00');                      // a Wednesday; today starts at 2026-10-27T19:00Z
  const passwordHash = await hashPassword(PASSWORD);
  cookies = {}; staff = {};
  for (const role of ['manager', 'head']) {
    staff[role] = await createStaff(db, { login: 'u-' + role, name: role, role, passwordHash });
    const res = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'domus-admin' },
      body: JSON.stringify({ login: 'u-' + role, password: PASSWORD }) });
    assert.equal(res.status, 200);
    cookies[role] = res.headers.get('set-cookie').split(';')[0];
  }
});
afterEach(() => fakeClock.reset());

async function get(path, role = 'head') {
  const res = await fetch(base + path, { headers: role ? { cookie: cookies[role] } : {} });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const ago = ms => new Date(now().getTime() - ms);

// A booking of a client: heldAgo / paidAgo (ms before now, null = not paid), status, minutes left to expires_at.
async function book(clientId, apt, { status = 'booked', heldAgo = HOUR, paidAgo = heldAgo - MIN, left = 72 * HOUR, price } = {}) {
  const p = (await db.one('SELECT price FROM apartments WHERE no = $1', [apt])).price;
  return db.one(`INSERT INTO bookings (apartment_no, client_id, status, channel, created_by, expires_at, held_at, booked_at, closed_at, deposit_amount, price_at_booking, updated_at)
    VALUES ($1, $2, $3, 'web', '{"type":"client"}', $4, $5, $6, $7, 10000000, $8, $5) RETURNING *`,
  [apt, clientId, status, new Date(now().getTime() + left), ago(heldAgo), paidAgo == null ? null : ago(paidAgo), ['converted', 'expired', 'cancelled'].includes(status) ? ago(1) : null, price ?? p]);
}
async function pay(b, { amount = 10_000_000, agoMs = HOUR, status = 'succeeded' } = {}) {
  return db.one(`INSERT INTO payments (code, kind, booking_id, client_id, provider, amount, status, succeeded_at, created_by, created_at, updated_at)
    VALUES ($1, 'deposit', $2, $3, 'card', $4, $5, $6, '{"type":"client"}', $6, $6) RETURNING *`, ['P-' + crypto.randomBytes(3).toString('hex'), b.id, b.client_id, amount, status, ago(agoMs)]);
}
const refund = (p, { amount, agoMs = 1000 } = {}) => db.query(`INSERT INTO refunds (payment_id, amount, reason, status, requested_by, created_at, updated_at, completed_at)
  VALUES ($1, $2, 'manual', 'succeeded', '{"type":"system"}', $3, $3, $3)`, [p.id, amount ?? p.amount, ago(agoMs)]);
const sell = async (b) => { await db.query('UPDATE apartments SET sold_at = $1, sold_booking_id = $2 WHERE no = $3', [ago(30 * MIN), b.id, b.apartment_no]); };

test('every entry needs a session; a bad period is refused', async () => {
  for (const p of ['/api/dashboard/summary', '/api/dashboard/charts', '/api/dashboard/feed']) assert.equal((await get(p, null)).status, 401, p);
  const r = await get('/api/dashboard/summary?period=year');
  assert.equal(r.status, 400);
  assert.deepEqual(r.body.fields, ['period']);
  assert.equal((await get('/api/dashboard/charts?period=1d')).status, 400);
});

test('tiles: sold with the price of its booking, in booking now, free, burning in 24 h', async () => {
  const c = await makeClient(db);
  const soldB = await book(c.id, 1, { status: 'converted', heldAgo: 2 * DAY, price: 777_000_000 });
  await sell(soldB);                                                           // sold today, by the price of the booking
  await book(c.id, 2, { status: 'booked', left: 5 * HOUR });                  // burns in 24 h
  await book(c.id, 3, { status: 'booked', left: 2 * DAY });
  await book(c.id, 4, { status: 'held', paidAgo: null, left: 10 * MIN });
  await book(c.id, 5, { status: 'expired', heldAgo: 5 * DAY });               // not active
  const s = (await get('/api/dashboard/summary?period=today')).body;
  assert.equal(s.tiles.sold.count, 1);
  assert.equal(s.tiles.sold.sum, 777_000_000);
  assert.equal(s.tiles.booked.count, 2);
  const prices = await db.query('SELECT price FROM apartments WHERE no IN (2, 3)');
  assert.equal(s.tiles.booked.sum, prices.reduce((a, r) => a + Number(r.price), 0));
  assert.deepEqual(s.tiles.free, { count: 92 - 1 - 2 - 1, total: 92, held: 1 });
  assert.equal(s.tiles.burning.count, 1);
  assert.deepEqual(s.period, { name: 'today', from: '2026-10-28', to: '2026-10-28' });
});

test('periods are Tashkent calendar days: today from 00:00, 7d and 30d include today', async () => {
  const c = await makeClient(db);
  await book(c.id, 10, { status: 'expired', heldAgo: 3 * HOUR });                         // 07:00 today
  await book(c.id, 11, { status: 'expired', heldAgo: 10 * HOUR + MIN });                  // 23:59 yesterday
  await book(c.id, 12, { status: 'expired', heldAgo: 6 * DAY + 5 * HOUR });               // 22nd 05:00 → the first day of 7d is whole, so in
  await book(c.id, 13, { status: 'expired', heldAgo: 6 * DAY });                          // 22nd 10:00 → in 7d (22…28)
  await book(c.id, 16, { status: 'expired', heldAgo: 7 * DAY });                          // 21st 10:00 → out of 7d, in 30d
  await book(c.id, 14, { status: 'expired', heldAgo: 29 * DAY });                         // 29th Sept → in 30d (29 Sept…28 Oct)
  await book(c.id, 15, { status: 'expired', heldAgo: 31 * DAY });                         // out
  const count = async p => (await get('/api/dashboard/summary?period=' + p)).body.funnel.bookings;
  assert.equal(await count('today'), 1);
  assert.equal(await count('7d'), 4);
  assert.equal(await count('30d'), 6);
  assert.deepEqual((await get('/api/dashboard/summary?period=7d')).body.period, { name: '7d', from: '2026-10-22', to: '2026-10-28' });
  assert.equal((await get('/api/dashboard/summary')).body.period.name, 'today');          // the default
});

test('deposits: received in the period minus refunds completed in it; compare with the previous period', async () => {
  const c = await makeClient(db);
  const b1 = await book(c.id, 20), b2 = await book(c.id, 21), b3 = await book(c.id, 22, { heldAgo: 2 * DAY });
  const p1 = await pay(b1, { agoMs: 2 * HOUR });
  await pay(b2, { agoMs: HOUR });
  const old = await pay(b3, { agoMs: DAY + 2 * HOUR });                                   // yesterday
  await refund(p1, { amount: 4_000_000, agoMs: 10 * MIN });                               // today: -4 m
  await refund(old, { agoMs: HOUR });                                                     // today too: -10 m, of a deposit received yesterday
  await db.query("UPDATE payments SET status = 'refund_due' WHERE id = $1", [p1.id]);     // a paid deposit that waits for a refund is still counted as received
  const s = (await get('/api/dashboard/summary?period=today')).body;
  assert.equal(s.tiles.deposits.count, 2);
  assert.equal(s.tiles.deposits.sum, 20_000_000 - 4_000_000 - 10_000_000);
  assert.equal(s.compare.deposits.prev, 10_000_000);
  assert.equal(s.compare.deposits.pct, -40);
  const week = (await get('/api/dashboard/summary?period=7d')).body;
  assert.equal(week.tiles.deposits.sum, 30_000_000 - 14_000_000);
  assert.equal(week.compare.deposits.pct, null);                                          // nothing before: no percentage
});

test('the funnel counts the cohort of the period: a step never exceeds the previous one; the conversions', async () => {
  const [a, b, c] = [await makeClient(db), await makeClient(db), await makeClient(db)];
  for (const d of [0, 0, 0, 1]) await db.query('INSERT INTO analytics_visits (day, visitor_hash, channel, first_at) VALUES ($1, $2, $3, $4)',
    [d === 0 ? '2026-10-28' : '2026-10-27', crypto.randomUUID(), 'web', now()]);
  const dialog = async (client, { mode = 'ai', msgAgo = 3 * HOUR, withMessage = true } = {}) => {
    const conv = await db.one(`INSERT INTO conversations (kind, client_id, channel, lang, mode, created_at, updated_at) VALUES ('client', $1, 'web', 'ru', $2, $3, $3) RETURNING id`, [client.id, mode, ago(msgAgo)]);
    if (withMessage) await db.query("INSERT INTO messages (conversation_id, role, text, created_at) VALUES ($1, 'user', 'Привет', $2)", [conv.id, ago(msgAgo)]);
    return conv;
  };
  await dialog(a);                                                                        // a: talks, then holds, pays, buys
  await dialog(b, { mode: 'human' });                                                     // b: talks, hands off, holds, never pays
  await dialog(c, { withMessage: false });                                                // c: opened the chat, wrote nothing — not a dialog
  const sold = await book(a.id, 30, { status: 'converted', heldAgo: 2 * HOUR, paidAgo: HOUR });
  await sell(sold);
  await book(b.id, 31, { status: 'expired', heldAgo: HOUR, paidAgo: 30 * MIN });
  await book(b.id, 32, { status: 'hold_expired', heldAgo: HOUR / 2, paidAgo: null });
  const s = (await get('/api/dashboard/summary?period=today')).body;
  assert.deepEqual(s.funnel, { visitors: 3, dialogs: 2, bookings: 3, paid: 2, sales: 1 });
  assert.ok(s.funnel.sales <= s.funnel.paid && s.funnel.paid <= s.funnel.bookings);
  assert.equal(s.conversions.visitorToDialog, 0.667);
  assert.equal(s.conversions.dialogToBooking, 1);                                         // both talking clients held after their first message
  assert.equal(s.conversions.bookingToSale, 0.5);
  assert.equal(s.conversions.expiredShare, 0.5);                                          // 1 of 2 paid bookings burned
  assert.equal(s.conversions.handoffShare, 0.5);
  assert.equal(s.conversions.medianFirstMessageToBookingMin, 135);                        // first message → paid booking: a 120 min, b 150 min; the unpaid hold is not a booking
  assert.equal((await get('/api/dashboard/summary?period=7d')).body.funnel.visitors, 4);
});

test('the AI activity of the period; money and the Gemini counters for the head only', async () => {
  const c = await makeClient(db);
  const conv = await db.one(`INSERT INTO conversations (kind, client_id, channel, lang, created_at, updated_at) VALUES ('client', $1, 'web', 'ru', $2, $2) RETURNING id`, [c.id, ago(HOUR)]);
  const t1 = crypto.randomUUID(), t2 = crypto.randomUUID();
  for (const [turn, ok, fallback] of [[t1, true, false], [t2, false, true]]) {
    await db.query(`INSERT INTO agent_runs (turn_id, conversation_id, agent, role, provider, model, fallback, steps, tools, input_tokens, output_tokens, cost_usd, ms, ok, error, created_at)
      VALUES ($1, $2, 'router', 'fast', 'gemini', 'gemini-3.5-flash-lite', $3, 1, '{}', 10, 5, 0.25, 100, $4, $5, $6)`, [turn, conv.id, fallback, ok, ok ? null : 'max_steps', ago(MIN)]);
  }
  await db.query("INSERT INTO tool_calls (at, source, tool, role, turn_id, conversation_id, args, ok, ms) VALUES ($1, 'agent', 'search_apartments', 'client', $2, $3, '{}', true, 5)", [ago(MIN), t1, conv.id]);
  await db.query("INSERT INTO messages (conversation_id, role, text, turn_id, feedback, created_at) VALUES ($1, 'assistant', 'a', $2, -1, $3), ($1, 'assistant', 'b', $4, 1, $3)", [conv.id, t1, ago(MIN), t2]);
  await db.query("INSERT INTO kb_queries (at, query, mode, answered) VALUES ($1, 'x', 'hybrid', false)", [ago(MIN)]);
  const head = (await get('/api/dashboard/summary')).body.ai;
  assert.deepEqual({ ...head, gemini: undefined }, { turns: 2, toolCalls: 1, errors: 1, fallbacks: 1, up: 1, down: 1, unanswered: 1, mode: 'primary', costUsd: 0.5, gemini: undefined });
  assert.ok(Array.isArray(head.gemini));
  const mgr = (await get('/api/dashboard/summary', 'manager')).body.ai;
  assert.equal(mgr.turns, 2);
  assert.ok(!('costUsd' in mgr) && !('gemini' in mgr));
});

test('charts: hours for today, days for a week with zero days kept, deposits net of refunds, the cut by rooms', async () => {
  const c = await makeClient(db);
  const b1 = await book(c.id, 40, { heldAgo: 2 * HOUR + 10 * MIN, paidAgo: 2 * HOUR });                      // 07:50 held, 08:00 paid (Tashkent)
  const b2 = await book(c.id, 41, { heldAgo: 3 * DAY, paidAgo: 3 * DAY - MIN });
  const p1 = await pay(b1, { agoMs: 2 * HOUR });                                                            // 08:00
  await pay(b2, { agoMs: 3 * DAY });
  await refund(p1, { amount: 3_000_000, agoMs: 30 * MIN });                                                 // 09:30
  const today = (await get('/api/dashboard/charts?period=today')).body;
  assert.equal(today.step, 'hour');
  assert.equal(today.deposits.length, 24);
  assert.deepEqual(today.deposits[8], { day: '2026-10-28', hour: 8, amount: 10_000_000 });
  assert.equal(today.deposits[9].amount, -3_000_000);
  assert.equal(today.deposits[10].amount, 0);
  assert.deepEqual(today.bookings[7], { day: '2026-10-28', hour: 7, held: 1, paid: 0 });
  assert.deepEqual(today.bookings[8], { day: '2026-10-28', hour: 8, held: 0, paid: 1 });

  const week = (await get('/api/dashboard/charts?period=7d')).body;
  assert.equal(week.step, 'day');
  assert.deepEqual(week.deposits.map(d => d.day), ['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28']);
  assert.deepEqual(week.deposits.map(d => d.amount), [0, 0, 0, 10_000_000, 0, 0, 7_000_000]);
  assert.deepEqual(week.bookings.map(d => d.held), [0, 0, 0, 1, 0, 0, 1]);
  assert.equal((await get('/api/dashboard/charts?period=30d')).body.deposits.length, 30);

  assert.deepEqual(today.byType.map(r => r.rooms), [0, 1, 2, 3, 4]);
  assert.equal(today.byType.reduce((a, r) => a + r.sold + r.booked + r.held + r.free, 0), 92);
  assert.equal(today.byType.reduce((a, r) => a + r.booked, 0), 2);
});

test('D-26: a manager gets counts only — no sold or deposits tiles, no compare, no deposits chart, no amount in the feed', async () => {
  const c = await makeClient(db);
  const b = await book(c.id, 50, { heldAgo: HOUR, paidAgo: HOUR - MIN });
  await pay(b, { agoMs: HOUR - MIN });
  await db.query("INSERT INTO events (at, type, actor, booking_id, apartment_no, data) VALUES ($1, 'booking.paid', '{\"type\":\"client\"}', $2, 50, '{\"amount\":10000000,\"provider\":\"card\"}')", [ago(MIN), b.id]);
  const s = (await get('/api/dashboard/summary?period=7d', 'manager')).body;
  assert.deepEqual(Object.keys(s.tiles).sort(), ['booked', 'burning', 'free']);
  assert.deepEqual(s.tiles.booked, { count: 1 });
  assert.ok(!('compare' in s));
  assert.equal(s.funnel.paid, 1);
  const body = JSON.stringify((await get('/api/dashboard/summary?period=7d', 'manager')).body);
  assert.ok(!/"sum"|"amount"|deposits|costUsd|10000000/.test(body), body);
  const ch = (await get('/api/dashboard/charts?period=7d', 'manager')).body;
  assert.ok(!('deposits' in ch));
  assert.equal(ch.bookings.length, 7);
  const feedM = (await get('/api/dashboard/feed', 'manager')).body.items;
  assert.equal(feedM.length, 1);
  assert.ok(!/сум|CARD|10 000 000/.test(feedM[0].text), feedM[0].text);
  const feedH = (await get('/api/dashboard/feed', 'head')).body.items;
  assert.match(feedH[0].text, /CARD · 10 000 000 сум/);
  const head = (await get('/api/dashboard/summary?period=7d')).body;
  assert.equal(head.tiles.deposits.sum, 10_000_000);
});

test('the feed: feed types only, newest first, texts without names, a link to the booking, the cursor, the language of the member', async () => {
  const c = await makeClient(db, { name: 'Дилноза', phone: '+998901234567' });
  const b = await book(c.id, 41, {});
  const ev = (type, extra = {}, data = {}, agoMs = 1000) => db.one("INSERT INTO events (at, type, actor, booking_id, apartment_no, client_id, data) VALUES ($1, $2, '{\"type\":\"system\"}', $3, $4, $5, $6) RETURNING id",
    [ago(agoMs), type, extra.booking ? b.id : null, extra.apt ?? null, extra.client ? c.id : null, JSON.stringify(data)]);
  const e1 = await ev('booking.paid', { booking: true, apt: 41, client: true }, {}, 5000);
  await ev('settings.changed', {}, { key: 'x' }, 4000);                                    // not a feed type
  const e3 = await ev('apartment.sold', { apt: 41 }, {}, 3000);
  const e4 = await ev('booking.hold_expired', { booking: true, apt: 41 }, {}, 20 * 1000);
  const all = (await get('/api/dashboard/feed')).body;
  assert.deepEqual(all.items.map(i => i.id), [e4.id, e3.id, e1.id]);
  assert.equal(all.last, e4.id);
  assert.equal(all.items[2].text, `Бронь №${b.no} оплачена · квартира №41`);
  assert.equal(all.items[2].link, `/admin#/bookings/${b.no}`);
  assert.equal(all.items[1].text, 'Квартира №41 продана');
  assert.equal(all.items[1].link, '/admin#/units/41');
  assert.ok(!JSON.stringify(all).includes('Дилноза') && !JSON.stringify(all).includes('998901234567'));
  const next = (await get(`/api/dashboard/feed?after=${e4.id}`)).body;
  assert.deepEqual(next.items.map(i => i.id), [e3.id, e1.id]);                             // the 15 s window repeats recent events whatever the cursor; the old e4 is not repeated
  assert.equal(next.last, e4.id);
  const uz = await db.one('SELECT id FROM staff WHERE login = $1', ['u-head']);
  await db.query("UPDATE staff SET lang = 'en' WHERE id = $1", [uz.id]);
  assert.equal((await get('/api/dashboard/feed?limit=1')).body.items.length, 1);
});
