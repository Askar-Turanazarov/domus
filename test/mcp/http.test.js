// 08 §7, 14 §5, §11 mcp/http: the token gate, two roles, the HTTP edges, the limits, the refusals in tool_calls.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { fakeClock } from '../../server/core/clock.js';
import { checkToken, mcpTokens, actorOf } from '../../server/mcp/index.js';
import { CLIENT_TOKEN, HEAD_TOKEN, start } from './helpers.js';

let s;
before(async () => { s = await start(); });
after(() => s.close());
beforeEach(async () => { await s.reset(); fakeClock.set('2026-10-28T10:00:00+05:00'); });
afterEach(() => fakeClock.reset());

test('checkToken: only the exact Bearer token', () => {
  assert.equal(checkToken(`Bearer ${HEAD_TOKEN}`, HEAD_TOKEN), true);
  for (const h of [undefined, '', 'Bearer', `Bearer ${HEAD_TOKEN}x`, HEAD_TOKEN.slice(1), `Basic ${HEAD_TOKEN}`]) assert.equal(checkToken(h, HEAD_TOKEN), false, String(h));
});

test('08 §7.1: the tokens — 32+ characters and different; a bad one switches its role off', () => {
  const ok = 'a'.repeat(32);
  assert.deepEqual(mcpTokens({ MCP_CLIENT_TOKEN: ok, MCP_HEAD_TOKEN: 'b'.repeat(40) }), { client: ok, head: 'b'.repeat(40) });
  assert.deepEqual(mcpTokens({ MCP_CLIENT_TOKEN: 'short', MCP_HEAD_TOKEN: ok }), { client: null, head: ok });
  assert.deepEqual(mcpTokens({ MCP_CLIENT_TOKEN: ok, MCP_HEAD_TOKEN: ok }), { client: null, head: null }, 'the same token twice: both off');
  assert.deepEqual(mcpTokens({}), { client: null, head: null });
});

test('08 §7.3: the actor — the client token → the demo client, the head token → the head without an id, else nobody', () => {
  const tokens = { client: CLIENT_TOKEN, head: HEAD_TOKEN };
  assert.deepEqual(actorOf(`Bearer ${CLIENT_TOKEN}`, tokens, { MCP_CLIENT_ID: 'c-1' }), { type: 'mcp', id: 'c-1', role: 'client', channel: 'mcp' });
  assert.deepEqual(actorOf(`Bearer ${HEAD_TOKEN}`, tokens), { type: 'mcp', id: null, role: 'head', channel: 'mcp' });
  assert.equal(actorOf('Bearer nope', tokens), null);
  assert.equal(actorOf(undefined, tokens), null);
});

test('08 §7.1: no tokens in the environment → 503 mcp_disabled, even for a request with some token', async () => {
  const off = await start({ env: { MCP_CLIENT_TOKEN: '', MCP_HEAD_TOKEN: '' } });
  try {
    const res = await off.rpc('tools/list', {}, 'x'.repeat(40));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'mcp_disabled' });
  } finally { await off.close(); }
});

test('08 §7.1: without a token or with a wrong one → 401 and a line of tool_calls (no tool, the reason, the hashed address)', async () => {
  for (const t of ['', 'wrong'.padEnd(40, 'y')]) {
    const res = await s.rpc('tools/list', {}, t);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('www-authenticate'), 'Bearer');
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
  }
  const rows = await s.db.query(`SELECT source, tool, role, ok, error, ip_hash FROM tool_calls ORDER BY id`);
  assert.deepEqual(rows.map(r => [r.source, r.tool, r.role, r.ok, r.error]), [['mcp', null, null, false, 'no_token'], ['mcp', null, null, false, 'bad_token']]);
  assert.match(rows[0].ip_hash, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(rows).includes('wrongyyyy'), 'the token is never written');
});

test('08 §7.1: other path → 404, GET → 405, bad JSON → 400, OPTIONS → 204 without CORS headers (14 §5)', async () => {
  const auth = { Authorization: `Bearer ${HEAD_TOKEN}` };
  assert.equal((await fetch(s.url.replace('/mcp', '/other'), { headers: auth })).status, 404);
  assert.equal((await fetch(s.url, { headers: auth })).status, 405);
  assert.equal((await fetch(s.url, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  const opt = await fetch(s.url, { method: 'OPTIONS' });
  assert.equal(opt.status, 204);
  assert.equal(opt.headers.get('access-control-allow-origin'), null);
});

test('08 §7.1: a body over 1 MB → 413', async () => {
  const res = await fetch(s.url, { method: 'POST', headers: { Authorization: `Bearer ${HEAD_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(1_100_000) } }) });
  assert.equal(res.status, 413);
});

// a raw request: fetch would normalise the path or refuse to cut the body
const raw = text => new Promise(ok => {
  const c = net.connect(new URL(s.url).port, '127.0.0.1', () => c.end(text));
  let out = '';
  c.on('data', d => { out += d; }).on('close', () => ok(out)).on('error', () => ok(out));
});

test('a malformed path (//) or a body cut mid-way does not bring the server down', async () => {
  assert.match(await raw('GET // HTTP/1.1\r\nHost: x\r\n\r\n'), /^HTTP\/1\.1 404/);
  await raw(`POST /mcp HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${HEAD_TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"jsonrpc"`);
  const res = await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(res.status, 200, 'the server still answers');
});

test('initialize answers as «chinor-park»', async () => {
  const res = await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal((await res.json()).result.serverInfo.name, 'chinor-park');
});

test('08 §7.1, FR-MCP-04: the tool list is made for the role — the client never sees the head\'s tools', async () => {
  const client = await s.names(CLIENT_TOKEN);
  const head = await s.names(HEAD_TOKEN);
  for (const n of ['search_apartments', 'get_apartment', 'calc_mortgage', 'calc_installment', 'compare_finance', 'search_kb', 'my_bookings',
    'book_viewing', 'create_booking', 'request_extension']) assert.ok(client.includes(n), n);
  assert.ok(!client.includes('call_manager'), 'the demo client cannot call a manager (08 §5)');
  for (const n of ['sales_summary', 'list_bookings', 'list_payments', 'list_viewings', 'extend_booking', 'cancel_booking']) {
    assert.ok(!client.includes(n), `client: ${n}`);
    assert.ok(head.includes(n), `head: ${n}`);
  }
  for (const n of ['create_booking', 'book_viewing', 'request_extension']) assert.ok(!head.includes(n), `head: ${n}`);
});

test('08 §6.3: the changing tools have the optional confirmToken in their schema', async () => {
  const tools = (await (await s.rpc('tools/list', {})).json()).result.tools;
  const extend = tools.find(t => t.name === 'extend_booking');
  assert.ok(extend.inputSchema.properties.confirmToken);
  assert.ok(!extend.inputSchema.required.includes('confirmToken'));
  assert.equal(extend.inputSchema.additionalProperties, false);
  assert.match(extend.description, /confirmToken only after the user explicitly agrees/);
  assert.equal(tools.find(t => t.name === 'list_bookings').inputSchema.properties.confirmToken, undefined);
});

test('08 §7.2: 60 calls a minute per token — the 61st is 429 with Retry-After; the window moves on', async () => {
  for (let i = 0; i < 60; i++) assert.equal((await s.rpc('tools/list', {}, CLIENT_TOKEN)).status, 200, `call ${i + 1}`);
  const over = await s.rpc('tools/list', {}, CLIENT_TOKEN);
  assert.equal(over.status, 429);
  assert.ok(Number(over.headers.get('retry-after')) >= 1);
  assert.equal((await s.rpc('tools/list', {}, HEAD_TOKEN)).status, 200, 'the other token has its own window');
  fakeClock.set('2026-10-28T10:01:01+05:00');
  assert.equal((await s.rpc('tools/list', {}, CLIENT_TOKEN)).status, 200);
});

test('08 §7.2: 20 refused tries a minute per address — then 429 instead of 401', async () => {
  for (let i = 0; i < 20; i++) assert.equal((await s.rpc('tools/list', {}, 'bad'.padEnd(40, 'z'))).status, 401);
  assert.equal((await s.rpc('tools/list', {}, 'bad'.padEnd(40, 'z'))).status, 429);
  assert.equal((await s.rpc('tools/list', {}, HEAD_TOKEN)).status, 200, 'a right token is not blocked by the address window');
});
