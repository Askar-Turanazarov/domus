// 08 §5, §11 tools/rights: every role × entry × tool; someone else's booking → booking_not_found; request_extension and
// call_manager — an event and one message, repeats within 10 minutes change nothing.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock } from '../../server/core/clock.js';
import { createTools } from '../../server/tools/registry.js';
import { CLIENT_TOOLS, ALL_TOOLS } from '../../server/tools/client.js';
import { HEAD_TOOLS } from '../../server/tools/head.js';
import { createTestDb, resetDb } from '../support/db.js';
import { makeClient, makeBooking, makeStaff, asClient, asStaff } from '../support/factories.js';

let db;
const ENV = { TELEGRAM_STAFF_CHAT_ID: '-1', LINK_SECRET: 'test-secret', PUBLIC_URL: 'https://x.test' };
before(async () => { db = await createTestDb(); });
after(() => db.close());
beforeEach(async () => { await resetDb(db); fakeClock.set('2026-10-28T10:00:00+05:00'); });
afterEach(() => fakeClock.reset());

const READING = ['search_apartments', 'get_apartment', 'calc_mortgage', 'calc_installment', 'compare_finance', 'search_kb'];
const ALL = CLIENT_TOOLS.map(t => t.name);
const HEAD_ONLY = HEAD_TOOLS.map(t => t.name);
const HEAD_MCP = { type: 'mcp', id: null, role: 'head', channel: 'mcp' };

test('08 §5: the matrix — chat client all, MCP client all but call_manager, head the reading ones, manager none', async () => {
  const tools = createTools({ db, env: ENV });
  const c = await makeClient(db);
  const m = await makeStaff(db);
  const names = ctx => tools.list(ctx).map(t => t.name);
  assert.deepEqual(names({ actor: asClient(c), source: 'agent' }), ALL);
  assert.deepEqual(names({ actor: { type: 'mcp', id: c.id, role: 'client', channel: 'mcp' }, source: 'mcp' }), ALL.filter(n => n !== 'call_manager'));
  assert.deepEqual(names({ actor: HEAD_MCP, source: 'mcp' }), [...READING, ...HEAD_ONLY]);
  assert.deepEqual(names({ actor: { type: 'staff', id: null, role: 'head', channel: 'admin' }, source: 'agent' }), [...READING, ...HEAD_ONLY.filter(n => !['extend_booking', 'cancel_booking'].includes(n))],
    'the analyst: the reading tools only');
  for (const n of HEAD_ONLY) assert.equal((await tools.run(n, {}, { actor: asClient(c), source: 'agent', lang: 'en' })).error, 'forbidden', n);
  assert.deepEqual(names({ actor: asStaff(m), source: 'agent' }), []);
  assert.deepEqual(names({ actor: null, source: 'agent' }), []);
  for (const name of ALL.filter(n => !READING.includes(n))) {
    const r = await tools.run(name, {}, { actor: HEAD_MCP, source: 'mcp', lang: 'en' });
    assert.equal(r.error, 'forbidden', name);
  }
  const r = await tools.run('call_manager', {}, { actor: { type: 'mcp', id: c.id, role: 'client', channel: 'mcp' }, source: 'mcp' });
  assert.equal(r.error, 'forbidden');
  assert.equal((await db.query(`SELECT 1 FROM tool_calls WHERE error = 'forbidden'`)).length, ALL.length - READING.length + 1 + HEAD_ONLY.length);
});

test('08 §5: my_bookings shows only the own bookings (merged cards too); a client without a card sees nothing', async () => {
  const tools = createTools({ db, env: ENV });
  const anya = await makeClient(db, { phone: '+998901234567' });
  const old = await makeClient(db, { name: 'Аня', phone: '+998901234567' });
  const boris = await makeClient(db, { name: 'Борис', phone: '+998907654321' });
  await db.query('UPDATE clients SET merged_into = $1 WHERE id = $2', [anya.id, old.id]);
  await makeBooking(db, { apartmentNo: 41, clientId: anya.id, status: 'booked', minutes: 600 });
  await makeBooking(db, { apartmentNo: 42, clientId: old.id, status: 'held' });
  await makeBooking(db, { apartmentNo: 43, clientId: boris.id, status: 'booked', minutes: 600 });
  const mine = await tools.run('my_bookings', {}, { actor: asClient(anya), source: 'agent' });
  assert.deepEqual(mine.out.items.map(b => b.apartmentNo).sort(), [41, 42]);
  assert.ok(mine.out.items.every(b => b.link.startsWith('https://x.test/b/')));
  const none = await tools.run('my_bookings', {}, { actor: { type: 'client', id: null, role: 'client', channel: 'web' }, source: 'agent' });
  assert.deepEqual(none.out.items, []);
});

test('08 §5: request_extension of someone else\'s booking → booking_not_found; own → an event and one message', async () => {
  const tools = createTools({ db, env: ENV });
  const anya = await makeClient(db);
  const boris = await makeClient(db, { name: 'Борис' });
  const b = await makeBooking(db, { apartmentNo: 41, clientId: anya.id, status: 'booked', minutes: 600 });
  const held = await makeBooking(db, { apartmentNo: 42, clientId: anya.id, status: 'held' });
  const alien = await tools.run('request_extension', { bookingNo: b.no }, { actor: asClient(boris), source: 'agent', lang: 'en' });
  assert.equal(alien.error, 'booking_not_found');
  assert.equal((await tools.run('request_extension', { bookingNo: 99999 }, { actor: asClient(anya), source: 'agent' })).error, 'booking_not_found');
  assert.equal((await tools.run('request_extension', { bookingNo: held.no }, { actor: asClient(anya), source: 'agent' })).error, 'booking_not_active');
  const r = await tools.run('request_extension', { bookingNo: b.no, hours: 24 }, { actor: asClient(anya), source: 'agent' });
  assert.equal(r.out.requested, true);
  assert.equal(r.out.repeated, false);
  fakeClock.set('2026-10-28T10:05:00+05:00');
  const again = await tools.run('request_extension', { bookingNo: b.no }, { actor: asClient(anya), source: 'agent' });
  assert.equal(again.out.repeated, true);
  assert.equal((await db.query(`SELECT 1 FROM events WHERE type = 'booking.extend_requested'`)).length, 1);
  const msg = await db.query(`SELECT template, vars FROM outbox WHERE template = 'staff_extend_requested'`);
  assert.equal(msg.length, 1);
  assert.equal(msg[0].vars.hoursText, ' (+24 ч)');
  assert.equal((await db.one('SELECT status, expires_at FROM bookings WHERE id = $1', [b.id])).expires_at.getTime(), b.expires_at.getTime());
});

test('07 §9: call_manager — the dialog goes to a person, staff_handoff with the masked phone, a repeat is quiet', async () => {
  const tools = createTools({ db, env: ENV });
  const c = await makeClient(db, { phone: '+998901234567', channel: 'telegram' });
  const conv = await db.one(`INSERT INTO conversations (kind, client_id, channel, lang, created_at, updated_at)
    VALUES ('client', $1, 'telegram', 'ru', $2, $2) RETURNING id`, [c.id, new Date('2026-10-28T05:00:00Z')]);
  const ctx = { actor: asClient(c, 'telegram'), source: 'agent', conversationId: conv.id, summary: 'Хочет скидку на №41' };
  const r = await tools.run('call_manager', { reason: 'complaint' }, ctx);
  assert.deepEqual(r.out, { requested: true, repeated: false });
  assert.equal((await db.one('SELECT mode FROM conversations WHERE id = $1', [conv.id])).mode, 'human');
  const o = await db.one(`SELECT vars FROM outbox WHERE template = 'staff_handoff'`);
  assert.equal(o.vars.phoneMasked, '+998 90 *** ** 67');
  assert.equal(o.vars.context, 'Хочет скидку на №41');
  assert.equal((await tools.run('call_manager', {}, ctx)).out.repeated, true);
  assert.equal((await db.query(`SELECT 1 FROM outbox WHERE template = 'staff_handoff'`)).length, 1);
  const ev = await db.one(`SELECT data FROM events WHERE type = 'client.handoff_requested'`);
  assert.deepEqual(ev.data, { conversationId: conv.id, reason: 'complaint' });
});
