// Migrations and the base seed (02 §6, §8): repeatable, and the schema keeps its guarantees.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, migrationFiles, pendingMigrations } from '../server/db/migrate.js';
import { createTestDb, resetDb, seedBase } from './support/db.js';

let db;
before(async () => { db = await createTestDb(); });
after(() => db.close());

const now = new Date('2026-10-28T05:00:00Z');

test('migrations: all applied once, a second run does nothing', async () => {
  assert.deepEqual(migrationFiles(), ['001_core', '002_payments', '003_events', '004_ai', '005_kb', '006_service']);
  assert.deepEqual(await pendingMigrations(db), []);
  assert.deepEqual(await migrate(db), []);
  const n = await db.one("SELECT count(*) AS n FROM pg_tables WHERE schemaname = 'public'");
  assert.equal(n.n, 31);
});

test('seed --base: 92 apartments, default settings, repeat changes nothing and keeps edited settings', async () => {
  await resetDb(db);
  const c = await db.one('SELECT count(*) AS n, count(*) FILTER (WHERE rooms = 0) AS studios, min(floor) AS lo, max(floor) AS hi FROM apartments');
  assert.deepEqual(c, { n: 92, studios: 32, lo: 2, hi: 12 });
  assert.equal((await db.one("SELECT value FROM settings WHERE key = 'deposit_amount'")).value, 10000000);
  await db.query("UPDATE settings SET value = '20' WHERE key = 'hold_minutes'");
  assert.deepEqual(await seedBase(db), { apartments: 0, settings: 0 });
  assert.equal((await db.one("SELECT value FROM settings WHERE key = 'hold_minutes'")).value, 20);
});

async function client() {
  return (await db.one("INSERT INTO clients (first_channel, created_at, updated_at) VALUES ('web', $1, $1) RETURNING id", [now])).id;
}
const hold = (no, clientId, status = 'held', expires = new Date(now.getTime() + 15 * 60e3)) => db.one(
  `INSERT INTO bookings (apartment_no, client_id, status, channel, created_by, expires_at, held_at, deposit_amount, price_at_booking, updated_at, booked_at)
   VALUES ($1, $2, $3, 'web', '{"type":"client"}', $4, $5, 10000000, 1, $5, $6) RETURNING no`,
  [no, clientId, status, expires, now, status === 'held' ? null : now]);

test('bookings: numbers from 1001, one active per apartment (I1), an expired one no longer holds it', async () => {
  await resetDb(db);
  const c = await client();
  assert.equal((await hold(1, c)).no, 1001);
  await assert.rejects(hold(1, c), /bookings_one_active/);
  await hold(2, c, 'booked', new Date(now.getTime() - 1000));
  await db.query('UPDATE apartments SET sold_at = $1 WHERE no = 3', [now]);
  const st = await db.query(`SELECT a.no, CASE WHEN a.sold_at IS NOT NULL THEN 'sold' WHEN b.status = 'held' THEN 'held'
      WHEN b.status = 'booked' THEN 'booked' ELSE 'free' END AS status
    FROM apartments a LEFT JOIN bookings b ON b.apartment_no = a.no AND b.status IN ('held','booked') AND b.expires_at > $1
    WHERE a.no <= 4 ORDER BY a.no`, [now]);
  assert.deepEqual(st.map(r => r.status), ['held', 'free', 'sold', 'free']);
});

test('viewings: one per apartment and minute (I5); vector extension works', async () => {
  await resetDb(db);
  const c = await client();
  const add = () => db.query(`INSERT INTO viewings (apartment_no, client_id, at, name, phone, status, channel, created_by, created_at, updated_at)
    VALUES (5, $1, '2026-10-29T10:00+05:00', 'Тест', '+998900000001', 'scheduled', 'web', '{}', $2, $2)`, [c, now]);
  await add();
  await assert.rejects(add(), /viewings_slot/);
  const v = await db.one("SELECT '[1,0,0]'::vector(3) <=> '[0,1,0]'::vector(3) AS d");
  assert.equal(v.d, 1);
});
