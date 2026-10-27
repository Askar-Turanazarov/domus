// 08 §6, §11 tools/confirm: the draft, the execution from the row, a repeat, the expiry, changed arguments, someone else's actor.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock } from '../../server/core/clock.js';
import { createTools } from '../../server/tools/registry.js';
import { canonical, argsHash } from '../../server/tools/pending.js';
import { createTestDb, resetDb } from '../support/db.js';
import { makeClient, asClient } from '../support/factories.js';

let db, tools;
const ENV = { TELEGRAM_STAFF_CHAT_ID: '-1', LINK_SECRET: 'test-secret', PUBLIC_URL: 'https://x.test' };
before(async () => { db = await createTestDb(); tools = createTools({ db, env: ENV }); });
after(() => db.close());
beforeEach(async () => { await resetDb(db); fakeClock.set('2026-10-28T10:00:00+05:00'); });
afterEach(() => fakeClock.reset());

const conversation = c => db.one(`INSERT INTO conversations (kind, client_id, channel, lang, created_at, updated_at)
  VALUES ('client', $1, 'telegram', 'ru', $2, $2) RETURNING id`, [c.id, new Date('2026-10-28T05:00:00Z')]);
async function chat(name = 'Аня', phone = '+998901234567') {
  const c = await makeClient(db, { name, phone, channel: 'telegram' });
  return { c, ctx: { actor: asClient(c, 'telegram'), source: 'agent', lang: 'ru', conversationId: (await conversation(c)).id } };
}

test('canonical JSON: the key order does not change the hash', () => {
  assert.equal(canonical({ b: 1, a: { d: [1, 2], c: 'x' } }), '{"a":{"c":"x","d":[1,2]},"b":1}');
  assert.equal(argsHash({ a: 1, b: 2 }), argsHash({ b: 2, a: 1 }));
});

test('§6.1: the draft row — args after zod, the hash, the preview, the actor, 10 minutes; the hold is made only on confirm', async () => {
  const { c, ctx } = await chat();
  const d = await tools.run('create_booking', { apartmentNo: 41 }, ctx);
  const row = await db.one('SELECT * FROM pending_actions WHERE id = $1', [d.pendingActionId]);
  assert.equal(row.status, 'pending');
  assert.deepEqual(row.args, { apartmentNo: 41 });
  assert.equal(row.args_hash, argsHash({ apartmentNo: 41 }));
  assert.equal(row.client_id, c.id);
  assert.equal(row.conversation_id, ctx.conversationId);
  assert.equal(row.expires_at.toISOString(), '2026-10-28T05:10:00.000Z');
  assert.equal(row.confirm_token_hash, null, 'no token in the chat');
  assert.equal((await db.query('SELECT 1 FROM bookings')).length, 0);
  const x = await tools.confirm(d.pendingActionId, ctx);
  assert.equal(x.status, 'executed');
  const done = await db.one('SELECT status, result, decided_at FROM pending_actions WHERE id = $1', [d.pendingActionId]);
  assert.equal(done.status, 'executed');
  assert.equal(done.result.bookingNo, x.out.bookingNo);
  const key = await db.one(`SELECT key FROM idempotency_keys WHERE scope = 'hold'`);
  assert.equal(key.key, d.pendingActionId, 'idempotencyKey = the draft id');
  const j = await db.query(`SELECT phase, pending_action_id, ok FROM tool_calls WHERE tool = 'create_booking' ORDER BY id`);
  assert.deepEqual(j.map(r => [r.phase, r.pending_action_id, r.ok]), [['preview', d.pendingActionId, true], ['execute', d.pendingActionId, true]]);
});

test('§6.1: a repeat finds nothing to execute — confirm_used with the first result; one hold', async () => {
  const { ctx } = await chat();
  const d = await tools.run('create_booking', { apartmentNo: 41 }, ctx);
  const [a, b] = await Promise.all([tools.confirm(d.pendingActionId, ctx), tools.confirm(d.pendingActionId, ctx)]);
  const ok = [a, b].filter(r => r.status === 'executed' && !r.error);
  const used = [a, b].filter(r => r.error === 'confirm_used');
  assert.equal(ok.length, 1);
  assert.equal(used.length, 1);
  const again = await tools.confirm(d.pendingActionId, ctx);
  assert.equal(again.error, 'confirm_used');
  assert.equal(again.result.bookingNo, ok[0].out.bookingNo);
  assert.equal((await db.query('SELECT 1 FROM bookings')).length, 1);
});

test('§6.1: expired after 10 minutes → confirm_expired and the row expired; renew makes a new draft', async () => {
  const { ctx } = await chat();
  const d = await tools.run('create_booking', { apartmentNo: 41 }, ctx);
  fakeClock.set('2026-10-28T10:10:00+05:00');
  assert.equal((await tools.confirm(d.pendingActionId, ctx)).error, 'confirm_expired');
  assert.equal((await db.one('SELECT status FROM pending_actions WHERE id = $1', [d.pendingActionId])).status, 'expired');
  const r = await tools.renew(d.pendingActionId, ctx);
  assert.equal(r.pending, true);
  assert.notEqual(r.pendingActionId, d.pendingActionId);
  assert.deepEqual(r.args, { apartmentNo: 41 });
});

test('§6.2: someone else\'s actor or dialog → confirm_mismatch, nothing executed; arguments changed in the row → confirm_mismatch', async () => {
  const { ctx } = await chat();
  const other = await chat('Борис', '+998907654321');
  const d = await tools.run('create_booking', { apartmentNo: 41 }, ctx);
  assert.equal((await tools.confirm(d.pendingActionId, other.ctx)).error, 'confirm_mismatch');
  assert.equal((await tools.confirm(d.pendingActionId, { ...ctx, conversationId: other.ctx.conversationId })).error, 'confirm_mismatch');
  assert.equal((await tools.confirm('not-a-uuid', ctx)).error, 'pending_not_found');
  await db.query(`UPDATE pending_actions SET args = '{"apartmentNo": 42}' WHERE id = $1`, [d.pendingActionId]);
  assert.equal((await tools.confirm(d.pendingActionId, ctx)).error, 'confirm_mismatch');
  assert.equal((await db.query('SELECT 1 FROM bookings')).length, 0);
  assert.equal((await db.one('SELECT status FROM pending_actions WHERE id = $1', [d.pendingActionId])).status, 'pending');
});

test('07 §8.1: a new draft of the same tool cancels the old one; the old id is no longer valid', async () => {
  const { ctx } = await chat();
  const a = await tools.run('create_booking', { apartmentNo: 41 }, ctx);
  const b = await tools.run('create_booking', { apartmentNo: 42 }, ctx);
  assert.equal((await db.one('SELECT status FROM pending_actions WHERE id = $1', [a.pendingActionId])).status, 'cancelled');
  assert.equal((await tools.confirm(a.pendingActionId, ctx)).error, 'pending_not_found');
  assert.equal((await tools.confirm(b.pendingActionId, ctx)).out.apartmentNo, 42);
});

test('§6.1: the core refuses at execution (the apartment was taken) → failed with the code', async () => {
  const { ctx } = await chat();
  const other = await chat('Борис', '+998907654321');
  const d = await tools.run('create_booking', { apartmentNo: 41 }, ctx);
  const o = await tools.run('create_booking', { apartmentNo: 41 }, other.ctx);
  assert.equal((await tools.confirm(o.pendingActionId, other.ctx)).status, 'executed');
  const r = await tools.confirm(d.pendingActionId, ctx);
  assert.equal(r.status, 'failed');
  assert.equal(r.error, 'apartment_not_free');
  const row = await db.one('SELECT status, result FROM pending_actions WHERE id = $1', [d.pendingActionId]);
  assert.deepEqual([row.status, row.result], ['failed', { error: 'apartment_not_free' }]);
});

test('§6.3 MCP: token pa_…, only its hash stored; changed args → confirm_mismatch; another token role → mismatch; used', async () => {
  const c = await makeClient(db, { name: 'MCP-клиент', phone: '+998901234567', channel: 'mcp' });
  const ctx = { actor: { type: 'mcp', id: c.id, role: 'client', channel: 'mcp' }, source: 'mcp', lang: 'en' };
  const d = await tools.run('create_booking', { apartmentNo: 41 }, ctx);
  assert.ok(d.model.needsConfirmation && d.model.confirmToken === d.confirmToken);
  const row = await db.one('SELECT confirm_token_hash FROM pending_actions');
  assert.ok(row.confirm_token_hash && !row.confirm_token_hash.includes(d.confirmToken));
  assert.equal((await tools.run('create_booking', { apartmentNo: 42, confirmToken: d.confirmToken }, ctx)).error, 'confirm_mismatch');
  const head = { actor: { type: 'mcp', id: null, role: 'head', channel: 'mcp' }, source: 'mcp' };
  assert.equal((await tools.run('create_booking', { apartmentNo: 41, confirmToken: d.confirmToken }, head)).error, 'forbidden');
  assert.equal((await tools.run('create_booking', { apartmentNo: 41, confirmToken: 'pa_nope' }, ctx)).error, 'pending_not_found');
  const ok = await tools.run('create_booking', { apartmentNo: 41, confirmToken: d.confirmToken }, ctx);
  assert.equal(ok.status, 'executed');
  assert.equal((await tools.run('create_booking', { apartmentNo: 41, confirmToken: d.confirmToken }, ctx)).error, 'confirm_used');
  const b = await db.one('SELECT channel FROM bookings');
  assert.equal(b.channel, 'mcp');
  const args = await db.query(`SELECT args FROM tool_calls WHERE tool = 'create_booking'`);
  assert.ok(!JSON.stringify(args).includes('pa_'), 'no token in the journal');
});
