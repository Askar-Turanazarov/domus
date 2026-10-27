// 08 §9, §11 tools/redact: no phone, name or token lands in tool_calls.args; book_viewing through MCP end to end.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock } from '../../server/core/clock.js';
import { createTools } from '../../server/tools/registry.js';
import { redactPii } from '../../server/tools/common.js';
import { createTestDb, resetDb } from '../support/db.js';
import { makeClient, asClient } from '../support/factories.js';

let db;
const ENV = { TELEGRAM_STAFF_CHAT_ID: '-1', LINK_SECRET: 'test-secret', PUBLIC_URL: 'https://x.test' };
before(async () => { db = await createTestDb(); });
after(() => db.close());
beforeEach(async () => { await resetDb(db); fakeClock.set('2026-10-28T10:00:00+05:00'); });
afterEach(() => fakeClock.reset());

test('redactPii: phone → mask, name → first letter, confirmToken dropped', () => {
  assert.deepEqual(redactPii({ no: 41, phone: '+998901234567', name: 'Анна', confirmToken: 'pa_secret' }),
    { no: 41, phone: '+998 90 *** ** 67', name: 'А.' });
});

test('08 §9: book_viewing via MCP — preview and execute rows hold no phone, name or token; the viewing is booked', async () => {
  const tools = createTools({ db, env: ENV });
  const c = await makeClient(db, { name: 'MCP-клиент', channel: 'mcp' });
  const ctx = { actor: { type: 'mcp', id: c.id, role: 'client', channel: 'mcp' }, source: 'mcp', lang: 'ru' };
  const args = { no: 41, datetime: '2026-10-30T15:00', name: 'Анна Каримова', phone: '90 123 45 67' };
  const p = await tools.run('book_viewing', args, ctx);
  assert.equal(p.pending, true);
  assert.match(p.confirmToken, /^pa_[\w-]{43}$/);
  assert.deepEqual(p.preview, { apartmentNo: 41, at: '2026-10-30T10:00:00.000Z', local: '2026-10-30 15:00' });
  const x = await tools.run('book_viewing', { ...args, confirmToken: p.confirmToken }, ctx);
  assert.equal(x.ok, true);
  const v = await db.one('SELECT name, phone, channel FROM viewings');
  assert.deepEqual(v, { name: 'Анна Каримова', phone: '+998901234567', channel: 'mcp' });
  const rows = await db.query(`SELECT phase, args FROM tool_calls WHERE tool = 'book_viewing' ORDER BY id`);
  assert.deepEqual(rows.map(r => r.phase), ['preview', 'execute']);
  const text = JSON.stringify(rows);
  for (const leak of ['1234567', '901234567', 'Анна', 'Каримова']) assert.ok(!text.includes(leak), leak);
  assert.ok(text.includes('2026-10-30T15:00'));
  const again = await tools.run('book_viewing', args, ctx);
  assert.equal(again.error, 'slot_taken');
});

test('book_viewing: outside working hours and without a phone are refused at the preview', async () => {
  const tools = createTools({ db, env: ENV });
  const c = await makeClient(db, { channel: 'telegram' });
  const ctx = { actor: asClient(c, 'telegram'), source: 'agent', lang: 'ru' };
  assert.equal((await tools.run('book_viewing', { no: 41, datetime: '2026-10-30T15:00' }, ctx)).error, 'need_phone');
  await db.query(`UPDATE clients SET phone = '+998901234567' WHERE id = $1`, [c.id]);
  assert.equal((await tools.run('book_viewing', { no: 41, datetime: '2026-10-30T21:00' }, ctx)).error, 'outside_hours');
  assert.equal((await tools.run('book_viewing', { no: 41, datetime: '2026-10-30T15:00', phone: '+1' }, ctx)).pending, true,
    'in the chat the phone argument is ignored — the card is used');
  assert.equal((await db.query('SELECT 1 FROM viewings')).length, 0);
});
