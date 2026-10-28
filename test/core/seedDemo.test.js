// 02 §8: seed --demo — 19 sales, 17 live bookings (3 burn «tomorrow», 2 in 6…20 h), the burnt, cancelled and expired ones, viewings, visitors, dialogs;
// the dashboard has something to draw for every period; the same `now` gives the same data; nothing is sent to anyone.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, resetDb } from '../support/db.js';
import { seedDemo } from '../../server/db/seed/demo.js';
import { dashboardSummary, dashboardCharts, dashboardFeed } from '../../server/core/analytics.js';
import { listBookings } from '../../server/core/bookings.js';

const NOW = new Date('2026-11-02T09:00:00+05:00');
const HEAD = { type: 'staff', id: null, role: 'head', channel: 'admin' };
const opts = { now: () => NOW, env: { LINK_SECRET: 'test-secret' } };
const H = 3600e3;
let db, report;

before(async () => {
  db = await createTestDb();
  await resetDb(db);
  report = await seedDemo(db, { now: NOW });
});
after(() => db.close());

const count = async (sql, args = []) => (await db.one(sql, args)).n;

test('the history has the sizes of 02 §8.3', async () => {
  assert.equal(report.clients, 45);
  assert.equal(await count("SELECT count(*)::int AS n FROM apartments WHERE sold_at IS NOT NULL"), 19);
  const by = Object.fromEntries((await db.query('SELECT status, count(*)::int AS n FROM bookings GROUP BY status')).map(r => [r.status, r.n]));
  assert.deepEqual(by, { booked: 17, converted: 19, expired: 6, cancelled: 3, hold_expired: 12 });
  assert.equal(await count("SELECT count(*)::int AS n FROM apartments a WHERE sold_at IS NULL AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.apartment_no = a.no AND b.status = 'booked')"), 56);
  assert.equal(await count("SELECT count(*)::int AS n FROM viewings WHERE status = 'scheduled'"), 10);
  assert.ok(await count("SELECT count(*)::int AS n FROM viewings WHERE status IN ('done', 'no_show')") >= 6);
  const visits = await db.query('SELECT day, count(*)::int AS n FROM analytics_visits GROUP BY day');
  assert.equal(visits.length, 30);
  assert.ok(visits.slice(1).every(v => v.n >= 35 && v.n <= 260), JSON.stringify(visits.map(v => v.n)));
  assert.ok(await count('SELECT count(*)::int AS n FROM conversations') >= 60);
});

test('deadlines: 3 burn tomorrow (now + 26…34 h), 2 in 6…20 h, the rest later; two were extended', async () => {
  const live = await db.query("SELECT expires_at, extended_count FROM bookings WHERE status = 'booked'");
  const hours = live.map(b => (b.expires_at - NOW) / H).sort((a, b) => a - b);
  assert.equal(hours.filter(h => h >= 6 && h <= 20).length, 2);
  assert.equal(hours.filter(h => h >= 26 && h <= 34).length, 3);
  assert.ok(hours.filter(h => h > 34).every(h => h >= 40 && h <= 72.1), JSON.stringify(hours));
  assert.equal(live.filter(b => b.extended_count > 0).length, 2);
  // what the MCP tool lists: within 24 h → the two; within 36 h → the five, three of them tomorrow
  assert.equal((await listBookings(db, { expiringWithinHours: 24 }, opts)).length, 2);
  const day = await listBookings(db, { expiringWithinHours: 36 }, opts);
  assert.equal(day.length, 5);
  assert.equal(day.filter(b => b.expires_at - NOW > 24 * H).length, 3);
});

test('every live booking has its expire job; nothing is queued for sending', async () => {
  assert.equal(await count("SELECT count(*)::int AS n FROM jobs WHERE type = 'booking.expire' AND status = 'scheduled'"), 17);
  assert.equal(await count("SELECT count(*)::int AS n FROM jobs WHERE type = 'booking.remind' AND run_at <= $1", [NOW]), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM outbox'), 0);
});

test('money: a deposit per paid booking, the refunds of the two returned ones, the providers of the live ones 9 / 4 / 4', async () => {
  assert.equal(await count("SELECT count(*)::int AS n FROM payments WHERE status = 'succeeded'"), 17 + 19 + 5 + 2);
  assert.equal(await count("SELECT count(*)::int AS n FROM payments WHERE status = 'failed'"), 5);
  assert.equal(await count("SELECT count(*)::int AS n FROM payments WHERE status = 'refunded'"), 2);
  assert.equal(await count("SELECT count(*)::int AS n FROM refunds WHERE status = 'succeeded'"), 2);
  const prov = Object.fromEntries((await db.query("SELECT p.provider, count(*)::int AS n FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE b.status = 'booked' GROUP BY 1")).map(r => [r.provider, r.n]));
  assert.deepEqual(prov, { card: 9, click: 4, stripe: 4 });
  assert.ok((await db.query('SELECT code FROM payments')).every(p => /^P-[0-9A-F]{8}$/.test(p.code)));
});

test('the dashboard is not empty for any period; the cohorts hold; today has a payment', async () => {
  for (const period of ['today', '7d', '30d']) {
    const s = await dashboardSummary(db, { period }, HEAD, opts);
    const f = s.funnel;
    assert.ok(f.visitors >= f.dialogs && f.bookings >= f.paid && f.paid >= f.sales, `${period} ${JSON.stringify(f)}`);
    const c = await dashboardCharts(db, { period }, HEAD, opts);
    assert.ok(c.deposits.some(p => p.amount > 0), period);
    assert.ok(c.bookings.some(p => p.held > 0), period);
  }
  const month = await dashboardSummary(db, { period: '30d' }, HEAD, opts);
  assert.equal(month.tiles.sold.count, 19);
  assert.equal(month.tiles.booked.count, 17);
  assert.deepEqual([month.tiles.free.count, month.tiles.free.total], [56, 92]);
  assert.equal(month.tiles.burning.count, 2);
  assert.ok(month.tiles.deposits.sum > 0 && month.funnel.sales === 19);
  assert.ok(month.ai.turns > 50);
  const days = (await dashboardCharts(db, { period: '30d' }, HEAD, opts)).deposits.filter(p => p.amount > 0).length;
  assert.ok(days >= 15, `deposits on ${days} days`);
  const today = await dashboardSummary(db, { period: 'today' }, HEAD, opts);
  assert.ok(today.funnel.paid >= 1 && today.tiles.deposits.sum > 0);
});

test('the feed is plausible: only feed types, newest first, nothing from the future, no names', async () => {
  const feed = await dashboardFeed(db, {}, HEAD, opts);
  assert.equal(feed.items.length, 50);
  assert.ok(feed.items.every((i, k) => k === 0 || i.id < feed.items[k - 1].id));
  assert.ok(feed.items.every(i => new Date(i.at) <= NOW));
  assert.ok(!JSON.stringify(feed).match(/Азиз|Дилноза|\+99890/));
});

test('the same moment gives the same data; another moment gives another history', async () => {
  const snap = async () => JSON.stringify(await db.query(`SELECT b.no, b.apartment_no, b.status, b.held_at, b.expires_at, c.name FROM bookings b JOIN clients c ON c.id = b.client_id ORDER BY b.no`));
  const first = await snap();
  const events = await count('SELECT count(*)::int AS n FROM events');
  await seedDemo(db, { now: NOW });
  assert.equal(await snap(), first);
  assert.equal(await count('SELECT count(*)::int AS n FROM events'), events);
  assert.equal(await count('SELECT count(*)::int AS n FROM bookings'), 57);
  await seedDemo(db, { now: new Date(NOW.getTime() + 2 * H) });
  assert.notEqual(await snap(), first);
});

test('the wipe keeps the apartments, the settings and the staff, and brings the numbering back to the start (№1001)', async () => {
  await db.query("INSERT INTO staff (login, name, role, password_hash, created_at) VALUES ('keep', 'Keep', 'head', 'x', $1) ON CONFLICT DO NOTHING", [NOW]);
  await seedDemo(db, { now: NOW });
  assert.equal(await count('SELECT count(*)::int AS n FROM apartments'), 92);
  assert.equal(await count('SELECT count(*)::int AS n FROM settings'), 12);
  assert.equal(await count("SELECT count(*)::int AS n FROM staff WHERE login = 'keep'"), 1);
  assert.equal(await count('SELECT min(no)::int AS n FROM bookings'), 1001);
});
