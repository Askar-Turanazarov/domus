// The storage contract (server/db.js): files always; Postgres only with TEST_DATABASE_URL (a throwaway Neon branch —
// the test writes orders and statuses there).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileDb, pgDb } from '../server/db.js';

function contract(name, make, opts = {}) {
  test(`db (${name}): orders, pictures, statuses, limit`, opts, async () => {
    const db = make();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const before = (await db.listOrders()).length;
    const ip = 'test-' + Math.random();
    const a = await db.addOrder({ name: 'A', phone: '+998901234567' }, [['plan.png', png]], ip);
    const b = await db.addOrder({ name: 'B', phone: '+998901234567' }, [], ip);
    assert.notEqual(a, b);
    const list = await db.listOrders();
    assert.equal(list.length, before + 2);
    const oa = list.find(o => o.id === a);
    assert.equal(oa.status, 'new');
    assert.equal(oa.name, 'A');
    assert.deepEqual(oa.files, [`orders/${a}/plan.png`]);
    assert.ok(!('files' in list.find(o => o.id === b)));
    assert.deepEqual(await db.orderFile(a, 'plan.png'), png);
    assert.equal(await db.orderFile(b, 'plan.png'), null);

    const upd = await db.updateOrder(a, o => { o.status = 'inWork'; o.note = 'call'; });
    assert.equal(upd.status, 'inWork');
    assert.equal((await db.listOrders()).find(o => o.id === a).note, 'call');
    assert.equal(await db.updateOrder(1, () => {}), null);

    await db.setStatus('test-building', 7, 'sold');
    await db.setStatus('test-building', 7, 'booked');
    assert.equal((await db.statuses())['test-building'][7], 'booked');

    // 5 orders per IP in 10 minutes (the two above count in Postgres; in files every call counts)
    const ip2 = 'limit-' + Math.random();
    let allowed = 0;
    for (let i = 0; i < 7; i++) {
      if (await db.allowOrder(ip2)) { allowed++; await db.addOrder({ name: 'L' }, [], ip2); }
    }
    assert.equal(allowed, 5);
  });

  test(`db (${name}): viewing bookings — one per apartment and minute, newest first`, opts, async () => {
    const db = make();
    const no = 900000 + Math.floor(Math.random() * 99999);   // not a real apartment: Postgres keeps the rows
    const bk = (datetime, createdAt) => ({ id: randomUUID(), no, name: 'Тест', phone: '+998 90 123 45 67', datetime, createdAt });
    const a = bk('2030-01-10T15:00+05:00', '2026-10-20T10:00:00.000Z');
    assert.deepEqual(await db.addBooking(a), a);
    assert.equal(await db.addBooking(bk('2030-01-10T10:00Z', '2026-10-20T10:01:00.000Z')), null, 'the same minute in UTC');
    const b = await db.addBooking(bk('2030-01-10T16:00+05:00', '2026-10-20T10:02:00.000Z'));
    const mine = (await db.listBookings()).filter(x => x.no === no);
    assert.deepEqual(mine.map(x => x.id), [b.id, a.id]);
    assert.equal(mine[1].phone, '+998 90 123 45 67');
  });

  test(`db (${name}): the MCP call log, newest first, limited`, opts, async () => {
    const db = make();
    const tag = 'test-' + Math.random();
    for (let i = 0; i < 3; i++) await db.logCall({ type: 'call', tool: 'search_apartments', ok: true, msg: `${tag} ${i}` });
    const mine = (await db.listCalls(50)).filter(e => String(e.msg).startsWith(tag));
    assert.deepEqual(mine.map(e => e.msg), [`${tag} 2`, `${tag} 1`, `${tag} 0`]);
    assert.ok(mine.every(e => !Number.isNaN(Date.parse(e.at))));
    assert.equal((await db.listCalls(2)).length, 2);
  });
}

contract('files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fsp3d-db-'));
  return fileDb({ ordersFile: join(dir, 'order.json'), filesDir: join(dir, 'orders'), statusFile: join(dir, 'data', 'st.json'),
    bookingsFile: join(dir, 'booking.json'), callsFile: join(dir, 'mcp-calls.jsonl') });
});

contract('postgres', () => pgDb(process.env.TEST_DATABASE_URL),
  { skip: !process.env.TEST_DATABASE_URL && 'TEST_DATABASE_URL is not set' });
