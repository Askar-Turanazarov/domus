// 08 §11 tools/registry: every tool is fully described; the run steps of §4 and the errors of §10.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { fakeClock } from '../../server/core/clock.js';
import { createTools, defineTool, jsonSchema } from '../../server/tools/registry.js';
import { ALL_TOOLS } from '../../server/tools/client.js';
import { createTestDb, resetDb } from '../support/db.js';
import { makeClient, asClient } from '../support/factories.js';

let db;
const ENV = { TELEGRAM_STAFF_CHAT_ID: '-1', LINK_SECRET: 'test-secret', PUBLIC_URL: 'https://x.test' };
before(async () => { db = await createTestDb(); });
after(() => db.close());
beforeEach(async () => { await resetDb(db); fakeClock.set('2026-10-28T10:00:00+05:00'); });
afterEach(() => fakeClock.reset());

const walk = (s, fn) => {
  fn(s);
  for (const v of Object.values(s.properties ?? {})) walk(v, fn);
  if (s.items) walk(s.items, fn);
};

test('08 §11: schema → JSON Schema, additionalProperties false everywhere, English description, 3 titles, roles, preview', () => {
  const names = new Set();
  for (const t of ALL_TOOLS) {
    assert.match(t.name, /^[a-z_]+$/);
    assert.ok(!names.has(t.name), `${t.name} twice`);
    names.add(t.name);
    const s = jsonSchema(t.input);
    assert.equal(s.type, 'object', t.name);
    walk(s, n => { if (n.type === 'object') assert.equal(n.additionalProperties, false, `${t.name}: an open object`); });
    assert.ok(t.description.length > 40 && /^[\x20-\x7e²–—«»]+$/.test(t.description), `${t.name}: an English description`);
    for (const l of ['ru', 'uz', 'en']) assert.ok(t.title[l], `${t.name}: title.${l}`);
    assert.ok(t.roles.length, `${t.name}: roles`);
    assert.equal(typeof t.run, 'function');
    if (t.mutates) assert.equal(typeof t.preview, 'function', `${t.name}: preview`);
    assert.ok(t.output, `${t.name}: output`);
  }
  assert.deepEqual(ALL_TOOLS.filter(t => t.mutates).map(t => t.name).sort(), ['book_viewing', 'cancel_booking', 'create_booking', 'extend_booking']);
  assert.ok(ALL_TOOLS.filter(t => t.roles.includes('head') && t.mutates).every(t => t.sources.length === 1 && t.sources[0] === 'mcp'),
    'changing tools of the head are for MCP only (the analyst never gets them, 08 §5)');
});

test('08 §4: unknown tool, invalid input with field names only, each refused call journaled', async () => {
  const tools = createTools({ db, env: ENV });
  const c = await makeClient(db);
  const ctx = { actor: asClient(c), source: 'agent', lang: 'en', turnId: '00000000-0000-4000-8000-000000000001' };
  const u = await tools.run('drop_tables', {}, ctx);
  assert.equal(u.error, 'unknown_tool');
  assert.ok(u.message);
  const bad = await tools.run('search_apartments', { rooms: 'two', color: 'red' }, ctx);
  assert.equal(bad.error, 'invalid_input');
  assert.deepEqual(bad.fields.sort(), ['color', 'rooms']);
  const rows = await db.query('SELECT tool, role, ok, error, turn_id, source FROM tool_calls ORDER BY id');
  assert.deepEqual(rows.map(r => [r.tool, r.ok, r.error]), [['drop_tables', false, 'unknown_tool'], ['search_apartments', false, 'invalid_input']]);
  assert.equal(rows[0].role, 'client');
  assert.equal(rows[0].turn_id, ctx.turnId);
});

test('08 §4: a reading tool runs, the journal has ms; search limits 10 for the agent, 100 via MCP; sorted by price', async () => {
  const tools = createTools({ db, env: ENV });
  const c = await makeClient(db);
  const r = await tools.run('search_apartments', { limit: 50 }, { actor: asClient(c), source: 'agent', lang: 'ru' });
  assert.equal(r.ok, true);
  assert.equal(r.out.total, 92);
  assert.equal(r.out.items.length, 10);
  assert.deepEqual(r.out.items.map(a => a.price), [...r.out.items.map(a => a.price)].sort((x, y) => x - y));
  assert.equal(r.out.items[0].url, `https://x.test/ru#apt=${r.out.items[0].no}`);
  const m = await tools.run('search_apartments', { limit: 50, status: 'any' }, { actor: { type: 'mcp', id: null, role: 'head', channel: 'mcp' }, source: 'mcp' });
  assert.equal(m.out.items.length, 50);
  assert.equal((await tools.run('search_apartments', { rooms: 2 }, { actor: asClient(c), source: 'agent' })).out.items.every(a => a.rooms === 2), true);
  const j = await db.one(`SELECT ok, ms, phase FROM tool_calls WHERE tool = 'search_apartments' LIMIT 1`);
  assert.equal(j.ok, true);
  assert.ok(Number.isInteger(j.ms));
  assert.equal(j.phase, null);
});

test('08 §10: a core error becomes { error, message } in the client language; get_apartment unknown no', async () => {
  const tools = createTools({ db, env: ENV });
  const c = await makeClient(db);
  const r = await tools.run('get_apartment', { no: 999 }, { actor: asClient(c), source: 'agent', lang: 'uz' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'apartment_not_found');
  assert.deepEqual(r.model, { error: 'apartment_not_found', message: r.message });
  const one = await tools.run('calc_mortgage', { no: 41, price: 1, years: 10, rate: 20 }, { actor: asClient(c), source: 'agent' });
  assert.equal(one.error, 'invalid_input');
  assert.deepEqual(one.fields, ['no', 'price', 'loan']);
});

test('08 §4 step 5: a tool that does not answer in time → tool_timeout; an unexpected throw → internal', async () => {
  const slow = defineTool({ name: 'slow', title: { ru: 'x', uz: 'x', en: 'x' }, description: 'x', input: z.strictObject({}),
    output: z.object({}), roles: ['client'], mutates: false, run: () => new Promise(r => setTimeout(r, 200)) });
  const boom = defineTool({ ...slow, name: 'boom', run: () => { throw new Error('db down'); } });
  const tools = createTools({ db, env: ENV, tools: [slow, boom], timeoutMs: 20, log: { error() {} } });
  const ctx = { actor: { type: 'client', id: null, role: 'client', channel: 'web' }, source: 'agent', lang: 'ru' };
  assert.equal((await tools.run('slow', {}, ctx)).error, 'tool_timeout');
  const b = await tools.run('boom', {}, ctx);
  assert.equal(b.error, 'internal');
  assert.ok(!JSON.stringify(b).includes('db down'), 'no stack or inner text goes to the model');
});

test('08 §6.1 step 1: a mutating tool returns the preview and writes nothing; the preview error comes at once', async () => {
  const tools = createTools({ db, env: ENV });
  const c = await makeClient(db, { phone: '+998901234567', channel: 'telegram' });
  const ctx = { actor: asClient(c, 'telegram'), source: 'agent', lang: 'ru' };
  const r = await tools.run('create_booking', { apartmentNo: 41 }, ctx);
  assert.equal(r.pending, true);
  assert.equal(r.model.pending, true);
  assert.ok(!('preview' in r.model), 'the model gets no terms and no link');
  assert.deepEqual(r.preview, { apartmentNo: 41, rooms: 3, area: 79.7, floor: 6, building: 'chinor-park', price: 1_024_500_000,
    deposit: 10_000_000, holdMinutes: 15, bookingHours: 72 });
  assert.equal((await db.query('SELECT 1 FROM bookings')).length, 0);
  assert.equal((await db.one(`SELECT phase FROM tool_calls WHERE tool = 'create_booking'`)).phase, 'preview');
  const x = await tools.confirm(r.pendingActionId, ctx);
  assert.equal(x.ok, true);
  assert.match(x.out.link, /^https:\/\/x\.test\/b\/\d+-/);
  const other = await makeClient(db, { name: 'Борис', phone: '+998907654321', channel: 'telegram' });
  const busy = await tools.run('create_booking', { apartmentNo: 41 }, { ...ctx, actor: asClient(other, 'telegram') });
  assert.equal(busy.error, 'apartment_not_free');
});

test('07 §5.3: on the site without a phone create_booking → need_phone; the dialog memory phone is enough', async () => {
  const tools = createTools({ db, env: ENV });
  const c = await makeClient(db);
  const ctx = { actor: asClient(c, 'web'), source: 'agent', lang: 'ru' };
  assert.equal((await tools.run('create_booking', { apartmentNo: 41 }, ctx)).error, 'need_phone');
  assert.equal((await tools.run('create_booking', { apartmentNo: 41 }, { ...ctx, contactPhone: '+998901112233' })).pending, true);
});

test('calc_installment / compare_finance: by apartment number, the paid deposit counted, first 3 payments and the last', async () => {
  const tools = createTools({ db, env: ENV });
  const c = await makeClient(db, { phone: '+998901234567' });
  await db.query(`UPDATE apartments SET price = 950000000 WHERE no = 41`);
  await db.query(`INSERT INTO bookings (apartment_no, client_id, status, channel, created_by, expires_at, held_at, booked_at,
    deposit_amount, price_at_booking, updated_at) VALUES (41, $1, 'booked', 'web', '{}', $2, $3, $3, 10000000, 950000000, $3)`,
  [c.id, new Date('2026-11-01T00:00:00Z'), new Date('2026-10-28T05:00:00Z')]);
  const ctx = { actor: asClient(c), source: 'agent', lang: 'ru' };
  const r = await tools.run('calc_installment', { no: 41, months: 12 }, ctx);
  assert.equal(r.out.depositPaid, 10_000_000);
  const p = r.out.plans[0];
  assert.equal(p.toPayNow, 275_000_000);
  assert.deepEqual(p.schedule, [{ month: 1, amount: 55_416_666 }, { month: 2, amount: 55_416_666 }, { month: 3, amount: 55_416_666 },
    { month: 12, amount: 55_416_674 }]);
  const all = await tools.run('calc_installment', { price: 950_000_000 }, ctx);
  assert.deepEqual(all.out.plans.map(x => x.months), [12, 24, 36]);
  assert.equal(all.out.depositPaid, null);
  const low = await tools.run('calc_installment', { price: 950_000_000, downPct: 10 }, { ...ctx, lang: 'en' });
  assert.equal(low.error, 'down_payment_too_low');
  assert.match(low.message, /30/);
  const cmp = await tools.run('compare_finance', { no: 41, mortgage: { years: 15, rate: 18 } }, ctx);
  assert.equal(cmp.out.needRate, false);
  assert.equal(cmp.out.rows.length, 4);
});
