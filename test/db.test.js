// The Domus storage interface over the new tables (server/db/legacy.js) on PGlite; on Neon too with TEST_DATABASE_URL
// (a throwaway branch — the test migrates it and writes rows).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDb } from '../server/db/index.js';
import { migrate } from '../server/db/migrate.js';
import { seedBase } from '../server/db/seed/base.js';
import { legacyStore } from '../server/db/legacy.js';

function contract(name, make, opts = {}) {
  let db;
  const open = async () => {
    if (!db) { db = make(); await migrate(await db.ready()); await seedBase(db); }
    return legacyStore(db);
  };
  after(() => db?.close());

  test(`db (${name}): orders, pictures, stages, limit; the name and phone live in clients`, opts, async () => {
    const store = await open();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const before = (await store.listOrders()).length;
    const ip = 'test-' + Math.random();
    const a = await store.addOrder({ name: 'A', phone: '90 123 45 67', comment: 'c', lang: 'uz', estimate: 5e8 }, [['plan.png', png]], ip);
    const b = await store.addOrder({ name: 'B', phone: '+998901234567', apartmentRef: { building: 'chinor-park', floor: 2, apt: 1 } }, [], ip);
    assert.ok(Number.isInteger(a) && b === a + 1);
    const list = await store.listOrders();
    assert.equal(list.length, before + 2);
    const oa = list.find(o => o.id === a);
    assert.deepEqual([oa.status, oa.name, oa.phone, oa.comment, oa.lang], ['new', 'A', '+998901234567', 'c', 'uz']);
    assert.deepEqual(oa.files, [`orders/${a}/plan.png`]);
    assert.ok(!('files' in list.find(o => o.id === b)));
    const row = await db.one('SELECT kind, apartment_no, estimate, doc FROM orders WHERE no = $1', [b]);
    assert.deepEqual([row.kind, row.apartment_no, row.estimate], ['apartment_request', 1, null]);
    assert.ok(!('name' in row.doc) && !('phone' in row.doc));
    assert.deepEqual(await store.orderFile(a, 'plan.png'), png);
    assert.equal(await store.orderFile(b, 'plan.png'), null);

    const upd = await store.updateOrder(a, o => { o.status = 'inWork'; o.note = 'call'; });
    assert.equal(upd.status, 'inWork');
    assert.equal((await store.listOrders()).find(o => o.id === a).note, 'call');
    assert.equal((await db.one('SELECT stage FROM orders WHERE no = $1', [a])).stage, 'in_work');
    assert.equal(await store.updateOrder(1, () => {}), null);

    // 5 orders per IP in 10 minutes (the two above count)
    const ip2 = 'limit-' + Math.random();
    let allowed = 0;
    for (let i = 0; i < 7; i++) {
      if (await store.allowOrder(ip2)) { allowed++; await store.addOrder({ name: 'L', phone: '+998900000001' }, [], ip2); }
    }
    assert.equal(allowed, 5);
  });

  test(`db (${name}): statuses computed from sales and bookings, held shows as booked`, opts, async () => {
    const store = await open();
    const c = await db.one("INSERT INTO clients (first_channel, created_at, updated_at) VALUES ('web', now(), now()) RETURNING id");
    await db.query(`INSERT INTO bookings (apartment_no, client_id, status, channel, created_by, expires_at, held_at, deposit_amount, price_at_booking, updated_at)
      VALUES (2, $1, 'held', 'web', '{}', now() + interval '15 minutes', now(), 1, 1, now())`, [c.id]);
    await db.query('UPDATE apartments SET sold_at = now() WHERE no = 3');
    const st = (await store.statuses())['chinor-park'];
    assert.equal(Object.keys(st).length, 92);
    assert.deepEqual([st[1], st[2], st[3]], ['free', 'booked', 'sold']);
    await db.query("UPDATE bookings SET status = 'released', closed_at = now() WHERE apartment_no = 2");
    await db.query('UPDATE apartments SET sold_at = NULL WHERE no = 3');
  });

  test(`db (${name}): viewings — one per apartment and minute, newest first`, opts, async () => {
    const store = await open();
    const no = 10 + Math.floor(Math.random() * 80);
    const day = 1 + Math.floor(Math.random() * 27);
    const at = h => `2031-01-${String(day).padStart(2, '0')}T${h}`;
    const bk = (datetime, createdAt) => ({ id: randomUUID(), no, name: 'Тест', phone: '+998 90 123 45 67', datetime, createdAt });
    const a = bk(at('15:00+05:00'), '2026-10-20T10:00:00.000Z');
    assert.deepEqual(await store.addBooking(a), a);
    assert.equal(await store.addBooking(bk(at('10:00Z'), '2026-10-20T10:01:00.000Z')), null, 'the same minute in UTC');
    const b = await store.addBooking(bk(at('16:00+05:00'), '2026-10-20T10:02:00.000Z'));
    const mine = (await store.listBookings()).filter(x => x.no === no && x.datetime.startsWith(at('')));
    assert.deepEqual(mine.map(x => x.id), [b.id, a.id]);
    assert.deepEqual(mine[1], { ...a, phone: '+998901234567' });
    // the refused one left no client behind
    assert.equal((await db.one(`SELECT count(*) AS n FROM clients c WHERE first_channel = 'mcp'
      AND NOT EXISTS (SELECT 1 FROM viewings v WHERE v.client_id = c.id)`)).n, 0);
  });

  test(`db (${name}): the MCP call log, newest first, limited; denied requests have no tool`, opts, async () => {
    const store = await open();
    const t0 = Date.now() + 3600e3;   // later than anything else in the log
    for (let i = 0; i < 3; i++) await store.logCall({ at: new Date(t0 + i).toISOString(), type: 'call', tool: 'search_apartments', ok: true, ms: i, args: { i } });
    await store.logCall({ at: new Date(t0 + 5).toISOString(), type: 'denied', reason: 'bad_token' });
    const top = await store.listCalls(4);
    assert.deepEqual(top.map(e => e.type === 'denied' ? e.reason : e.args.i), ['bad_token', 2, 1, 0]);
    assert.equal((await store.listCalls(2)).length, 2);
  });
}

contract('pglite', () => createDb({ url: '', dir: 'memory://' }));
contract('neon', () => createDb({ url: process.env.TEST_DATABASE_URL }),
  { skip: !process.env.TEST_DATABASE_URL && 'TEST_DATABASE_URL is not set' });
