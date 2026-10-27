// 08 §6.3, §9, §11 mcp/flow + tools/redact: the head through MCP — burning bookings, the two-step extension and cancellation,
// the summary and the lists with masked phones; the demo client; nothing secret in tool_calls.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock } from '../../server/core/clock.js';
import { makeClient, makeBooking } from '../support/factories.js';
import { CLIENT_TOKEN, HEAD_TOKEN, start } from './helpers.js';

let s;
before(async () => { s = await start(); });
after(() => s.close());
beforeEach(async () => { await s.reset(); fakeClock.set('2026-10-28T10:00:00+05:00'); });
afterEach(() => fakeClock.reset());

const PHONE = '+998901234567';
const MASKED = '+998 90 *** ** 67';
const text = r => r.content[0].text;

// Аня with a paid booking burning in 12 hours (apt 41), Борис with one in 100 hours (apt 42), and a hold (apt 43).
async function world() {
  const anya = await makeClient(s.db, { name: 'Аня', phone: PHONE });
  const boris = await makeClient(s.db, { name: 'Борис', phone: '+998907654321' });
  const a = await makeBooking(s.db, { apartmentNo: 41, clientId: anya.id, status: 'booked', minutes: 12 * 60 });
  const b = await makeBooking(s.db, { apartmentNo: 42, clientId: boris.id, status: 'booked', minutes: 100 * 60 });
  const h = await makeBooking(s.db, { apartmentNo: 43, clientId: anya.id, status: 'held', minutes: 15 });
  return { anya, boris, a, b, h };
}

test('«Какие брони сгорают завтра?»: list_bookings(expiringWithinHours) → only the live ones inside the window, the phone masked', async () => {
  const w = await world();
  const r = await s.call('list_bookings', { expiringWithinHours: 24 });
  assert.equal(r.isError, undefined);
  assert.deepEqual(r.structuredContent.items.filter(i => i.status === 'booked').map(i => i.bookingNo), [w.a.no]);
  const hit = r.structuredContent.items.find(i => i.bookingNo === w.a.no);
  assert.deepEqual(hit.client, { name: 'Аня', phone: MASKED });
  assert.equal(hit.apartmentNo, 41);
  assert.ok(!JSON.stringify(r).includes(PHONE), 'no full phone in the answer');
  const all = await s.call('list_bookings', {});
  assert.equal(all.structuredContent.total, 3);
  const held = await s.call('list_bookings', { status: 'held' });
  assert.deepEqual(held.structuredContent.items.map(i => i.bookingNo), [w.h.no]);
  const bad = await s.call('list_bookings', { expiringWithinHours: 'soon' });
  assert.equal(bad.isError, true);
});

test('08 §6.3: extend_booking — the first call is a draft with confirmToken and changes nothing; the second call extends', async () => {
  const w = await world();
  const draft = await s.call('extend_booking', { bookingNo: w.a.no, hours: 24 });
  assert.equal(draft.isError, undefined);
  assert.equal(draft.structuredContent.needsConfirmation, true);
  assert.match(draft.structuredContent.confirmToken, /^pa_[\w-]{43}$/);
  assert.equal(draft.structuredContent.preview.apartmentNo, 41);
  assert.equal(draft.structuredContent.preview.to, new Date(w.a.expires_at.getTime() + 24 * 3600e3).toISOString());
  assert.match(text(draft), /Требуется подтверждение/);
  assert.equal((await s.db.one('SELECT expires_at FROM bookings WHERE id = $1', [w.a.id])).expires_at.getTime(), w.a.expires_at.getTime());

  const done = await s.call('extend_booking', { bookingNo: w.a.no, hours: 24, confirmToken: draft.structuredContent.confirmToken });
  assert.equal(done.isError, undefined);
  assert.equal(done.structuredContent.until, new Date(w.a.expires_at.getTime() + 24 * 3600e3).toISOString());
  assert.match(text(done), /^Готово/);
  const row = await s.db.one('SELECT expires_at, extended_count FROM bookings WHERE id = $1', [w.a.id]);
  assert.equal(row.expires_at.toISOString(), done.structuredContent.until);
  assert.equal(row.extended_count, 1);

  const ev = await s.db.one(`SELECT actor, data FROM events WHERE type = 'booking.extended'`);
  assert.equal(ev.actor.channel, 'mcp', 'the event says «через Claude Desktop» (FR-MCP-05)');
  assert.equal(ev.actor.role, 'head');
  const kinds = await s.db.query(`SELECT phase, ok, source, role FROM tool_calls WHERE tool = 'extend_booking' ORDER BY id`);
  assert.deepEqual(kinds.map(r => [r.phase, r.ok, r.source, r.role]), [['preview', true, 'mcp', 'head'], ['execute', true, 'mcp', 'head']]);
  assert.ok((await s.db.query(`SELECT 1 FROM outbox WHERE template = 'booking_extended'`)).length >= 1, 'the client is told');
});

test('08 §6.3: the token is bound to the arguments, used once and valid for 10 minutes', async () => {
  const w = await world();
  const d1 = (await s.call('extend_booking', { bookingNo: w.a.no, hours: 24 })).structuredContent.confirmToken;
  const changed = await s.call('extend_booking', { bookingNo: w.a.no, hours: 100, confirmToken: d1 });
  assert.equal(changed.isError, true);
  assert.equal((await s.db.one('SELECT extended_count FROM bookings WHERE id = $1', [w.a.id])).extended_count, 0);
  assert.equal((await s.call('extend_booking', { bookingNo: w.b.no, hours: 24, confirmToken: d1 })).isError, true, 'another booking');
  assert.equal((await s.call('extend_booking', { bookingNo: w.a.no, hours: 24, confirmToken: d1 })).isError, undefined);
  const again = await s.call('extend_booking', { bookingNo: w.a.no, hours: 24, confirmToken: d1 });
  assert.equal(again.isError, true, 'a second use');
  assert.equal((await s.db.one('SELECT extended_count FROM bookings WHERE id = $1', [w.a.id])).extended_count, 1);

  const d2 = (await s.call('extend_booking', { bookingNo: w.b.no, hours: 24 })).structuredContent.confirmToken;
  fakeClock.set('2026-10-28T10:11:00+05:00');
  const late = await s.call('extend_booking', { bookingNo: w.b.no, hours: 24, confirmToken: d2 });
  assert.equal(late.isError, true);
  assert.equal((await s.db.one('SELECT extended_count FROM bookings WHERE id = $1', [w.b.id])).extended_count, 0);
  assert.equal((await s.call('extend_booking', { bookingNo: w.a.no, hours: 24, confirmToken: 'pa_nonexistent-token' })).isError, true);
});

test('08 §6.1: the preview already refuses what cannot work — no draft is created', async () => {
  const w = await world();
  const none = await s.call('extend_booking', { bookingNo: 9999, hours: 24 });
  assert.equal(none.isError, true);
  assert.equal((await s.call('extend_booking', { bookingNo: w.h.no, hours: 24 })).isError, true, 'a hold is not extended');
  const long = await s.call('extend_booking', { bookingNo: w.b.no, hours: 120 });
  assert.equal(long.isError, true, 'beyond extend_max_hours (168 h from now)');
  assert.equal((await s.db.query('SELECT 1 FROM pending_actions')).length, 0);
});

test('08 §5: the client token cannot call the head\'s tools — nothing changes', async () => {
  const w = await world();
  const r = await (await s.rpc('tools/call', { name: 'extend_booking', arguments: { bookingNo: w.a.no, hours: 24 } }, CLIENT_TOKEN)).json();
  assert.ok(r.error || r.result?.isError, 'refused');
  assert.equal((await s.db.query('SELECT 1 FROM pending_actions')).length, 0);
  assert.equal((await s.db.one('SELECT extended_count FROM bookings WHERE id = $1', [w.a.id])).extended_count, 0);
});

test('08 §3.2: cancel_booking — a draft that says whether a refund follows, then the cancellation by the developer', async () => {
  const w = await world();
  const draft = await s.call('cancel_booking', { bookingNo: w.a.no, reason: 'Квартира снята с продажи' });
  assert.equal(draft.structuredContent.preview.refund, true);
  assert.equal(draft.structuredContent.preview.status, 'booked');
  const done = await s.call('cancel_booking', { bookingNo: w.a.no, reason: 'Квартира снята с продажи', confirmToken: draft.structuredContent.confirmToken });
  assert.deepEqual(done.structuredContent, { bookingNo: w.a.no, apartmentNo: 41, refund: true });
  const row = await s.db.one('SELECT status, cancel_initiator, cancel_reason FROM bookings WHERE id = $1', [w.a.id]);
  assert.deepEqual([row.status, row.cancel_initiator, row.cancel_reason], ['cancelled', 'developer', 'Квартира снята с продажи']);
  const ev = await s.db.one(`SELECT actor, data FROM events WHERE type = 'booking.cancelled'`);
  assert.equal(ev.actor.channel, 'mcp');
  assert.equal(ev.data.depositFate, 'refund');
  assert.equal((await s.call('cancel_booking', { bookingNo: w.a.no, reason: 'Ещё раз' })).isError, true, 'already closed');
  assert.equal((await s.call('cancel_booking', { bookingNo: w.b.no, reason: 'x' })).isError, true, 'a reason of 3+ characters');
});

test('08 §3.2: sales_summary — deposits that stay paid (refund_due is not revenue), holds, bookings, sales, conversion', async () => {
  const w = await world();
  const pay = (status, amount, at, booking = w.a, owner = w.anya) => s.db.query(`INSERT INTO payments (code, kind, booking_id, client_id, provider, amount, status, succeeded_at, created_by, created_at, updated_at)
    VALUES ($1, 'deposit', $2, $3, 'card', $4, $5, $6, '{"type":"system"}', $6, $6)`,
  [`P-${status}-${amount}`, booking.id, owner.id, amount, status, at]);
  await pay('succeeded', 10_000_000, new Date('2026-10-28T03:00:00Z'));
  await pay('refund_due', 7_000_000, new Date('2026-10-28T04:00:00Z'));
  await pay('succeeded', 5_000_000, new Date('2026-10-20T04:00:00Z'), w.b, w.boris);
  const today = await s.call('sales_summary', {});
  assert.deepEqual(today.structuredContent.deposits, { count: 1, sum: 10_000_000 });
  assert.equal(today.structuredContent.holds, 3);
  assert.equal(today.structuredContent.bookings, 2);
  assert.deepEqual(today.structuredContent.conversion, { holdToBooking: 0.667, bookingToSale: 0 });
  assert.deepEqual([today.structuredContent.from, today.structuredContent.to], ['2026-10-28', '2026-10-28']);
  const week = await s.call('sales_summary', { from: '2026-10-20', to: '2026-10-28' });
  assert.deepEqual(week.structuredContent.deposits, { count: 2, sum: 15_000_000 });
  assert.equal((await s.call('sales_summary', { from: 'yesterday' })).isError, true);
});

test('08 §3.2: list_payments and list_viewings — the client as a name and a masked phone, the card as the mask', async () => {
  const w = await world();
  await s.db.query(`INSERT INTO payments (code, kind, booking_id, client_id, provider, amount, status, card_mask, succeeded_at, created_by, created_at, updated_at)
    VALUES ('P-7F3A', 'deposit', $1, $2, 'card', 10000000, 'succeeded', '9860 •••• 0001', $3, '{"type":"system"}', $3, $3)`, [w.a.id, w.anya.id, fakeClock.now ? fakeClock.now() : new Date()]);
  await s.db.query(`INSERT INTO viewings (apartment_no, client_id, at, name, phone, status, channel, created_by, created_at, updated_at)
    VALUES (41, $1, $2, 'Аня', $3, 'scheduled', 'telegram', '{"type":"client"}', $4, $4)`, [w.anya.id, new Date('2026-10-30T10:00:00Z'), PHONE, new Date('2026-10-28T05:00:00Z')]);
  const p = await s.call('list_payments', { status: 'succeeded' });
  assert.deepEqual(p.structuredContent.items.map(i => [i.code, i.bookingNo, i.amount, i.card, i.client.phone]), [['P-7F3A', w.a.no, 10_000_000, '9860 •••• 0001', MASKED]]);
  assert.equal((await s.call('list_payments', { status: 'failed' })).structuredContent.total, 0);
  const v = await s.call('list_viewings', { from: '2026-10-30', to: '2026-10-30' });
  assert.deepEqual(v.structuredContent.items, [{ apartmentNo: 41, at: '2026-10-30 15:00', status: 'scheduled', channel: 'telegram', client: { name: 'Аня', phone: MASKED } }]);
  assert.equal((await s.call('list_viewings', { from: '2026-10-31' })).structuredContent.total, 0);
  assert.ok(!JSON.stringify([p, v]).includes(PHONE));
});

test('FR-MCP-02: the reading client tools answer through MCP with a typed result', async () => {
  const a = await s.call('search_apartments', { rooms: 2, limit: 3 }, CLIENT_TOKEN);
  assert.equal(a.isError, undefined);
  assert.equal(a.structuredContent.items.length, 3);
  assert.equal((await s.call('get_apartment', { no: 41 }, CLIENT_TOKEN)).structuredContent.no, 41);
  const m = await s.call('calc_mortgage', { loan: 80_000_000, years: 10, rate: 24 }, CLIENT_TOKEN);
  assert.equal(m.structuredContent.monthly, 1_763_848);
  assert.equal((await s.call('calc_installment', { no: 41 }, CLIENT_TOKEN)).isError, undefined);
  assert.equal((await s.call('compare_finance', { no: 41 }, CLIENT_TOKEN)).isError, undefined);
  assert.equal((await s.call('search_kb', { query: 'Когда сдача дома?' }, CLIENT_TOKEN)).isError, undefined);
  assert.equal((await s.call('get_apartment', { no: 9999 }, CLIENT_TOKEN)).isError, true);
  assert.equal((await s.call('search_apartments', { rooms: 2, surprise: 1 }, CLIENT_TOKEN)).isError, true, 'unknown arguments are an error');
  assert.equal((await s.call('get_apartment', { no: 41 })).isError, undefined, 'the head reads too');
});

test('D-24: the client token is the demo client — only its own bookings; a hold is made through the two steps', async () => {
  const w = await world();
  const demo = await makeClient(s.db, { name: 'MCP-клиент', phone: '+998900000001', channel: 'mcp' });
  s.env.MCP_CLIENT_ID = demo.id;
  try {
    assert.deepEqual((await s.call('my_bookings', {}, CLIENT_TOKEN)).structuredContent.items, []);
    const draft = await s.call('create_booking', { apartmentNo: 44 }, CLIENT_TOKEN);
    assert.equal(draft.isError, undefined, text(draft));
    assert.equal(draft.structuredContent.needsConfirmation, true);
    assert.equal((await s.db.query('SELECT 1 FROM bookings WHERE apartment_no = 44')).length, 0);
    const made = await s.call('create_booking', { apartmentNo: 44, confirmToken: draft.structuredContent.confirmToken }, CLIENT_TOKEN);
    assert.equal(made.isError, undefined, text(made));
    const mine = (await s.call('my_bookings', {}, CLIENT_TOKEN)).structuredContent.items;
    assert.deepEqual(mine.map(i => i.apartmentNo), [44]);
    assert.ok(!mine.some(i => [w.a.no, w.b.no].includes(i.bookingNo)), 'not Аня\'s, not Борис\'s');
    assert.equal((await s.db.one('SELECT channel FROM bookings WHERE apartment_no = 44')).channel, 'mcp');
    const foreign = await s.call('request_extension', { bookingNo: w.a.no }, CLIENT_TOKEN);
    assert.equal(foreign.isError, true, 'someone else\'s booking is not found');
  } finally { s.env.MCP_CLIENT_ID = ''; }
});

test('08 §9: tool_calls hold no tokens, no confirmToken, no full phones; failures are journaled with the code', async () => {
  const w = await world();
  const d = await s.call('extend_booking', { bookingNo: w.a.no, hours: 24 });
  await s.call('extend_booking', { bookingNo: w.a.no, hours: 24, confirmToken: d.structuredContent.confirmToken });
  await s.call('list_bookings', {});
  await s.call('get_apartment', { no: 9999 });
  await s.call('cancel_booking', { bookingNo: w.b.no, reason: 'Причина с телефоном +998901234567 для проверки' });
  const dump = JSON.stringify(await s.db.query('SELECT * FROM tool_calls'));
  assert.ok(!dump.includes('pa_'), 'no confirm token');
  assert.ok(!dump.includes(HEAD_TOKEN) && !dump.includes(CLIENT_TOKEN), 'no bearer token');
  const failed = await s.db.one(`SELECT ok, error FROM tool_calls WHERE tool = 'get_apartment'`);
  assert.deepEqual([failed.ok, failed.error], [false, 'apartment_not_found']);
  const rows = await s.db.query(`SELECT tool, role, source FROM tool_calls`);
  assert.ok(rows.every(r => r.source === 'mcp' && r.role === 'head'));
});
