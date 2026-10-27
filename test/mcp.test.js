// POST /mcp on the site: the MCP server «Chinor Park» as a route (as on Vercel). Token, tools, a booking that shows up
// on the manager's /api/bookings, the call log on /api/calls without the client's name and phone.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'fsp3d-mcp-'));
const TOKEN = 'site-mcp-test-token-'.padEnd(40, 'x');
Object.assign(process.env, { DATA_DIR: dir, BOOKING_FILE: join(dir, 'booking.json'), CALLS_FILE: join(dir, 'mcp-calls.jsonl'),
  ADMIN_TOKEN: 'mcp-site-test-admin-token', MCP_TOKEN: TOKEN, DATABASE_URL: '' });
const { default: app } = await import('../server.js');
const server = app.listen(0);
after(() => server.close());
const base = () => `http://127.0.0.1:${server.address().port}`;
const rpc = (method, params, token = TOKEN) => fetch(base() + '/mcp', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
});
const call = async (name, args) => (await (await rpc('tools/call', { name, arguments: args })).json()).result;
const admin = path => fetch(base() + path, { headers: { Authorization: 'Bearer ' + process.env.ADMIN_TOKEN } }).then(r => r.json());

test('no token or a wrong one → 401, logged as refused; GET → 405', async () => {
  for (const t of ['', 'wrong-token']) {
    const res = await rpc('tools/list', {}, t);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await fetch(base() + '/mcp', { headers: { Authorization: 'Bearer ' + TOKEN } })).status, 405);
  const reasons = (await admin('/api/calls')).filter(e => e.type === 'denied').map(e => e.reason);
  assert.deepEqual(reasons.sort(), ['bad_token', 'no_token']);
});

test('the four tools, search works', async () => {
  const res = await rpc('tools/list', {});
  assert.equal(res.status, 200);
  const names = (await res.json()).result.tools.map(t => t.name).sort();
  assert.deepEqual(names, ['book_viewing', 'calc_mortgage', 'get_apartment', 'search_apartments']);
  const r = await call('search_apartments', { rooms: 2, limit: 3 });
  assert.equal(r.isError, undefined);
  assert.ok(r.structuredContent.apartments.length > 0);
});

test('a booking lands on the manager page; the same slot again is refused; the log has no name or phone', async () => {
  const free = (await call('search_apartments', { limit: 1 })).structuredContent.apartments[0];
  const args = { name: 'Проверка Маршрута', phone: '+998 90 765 43 21', datetime: '2030-03-01T11:00', no: free.no };
  const r = await call('book_viewing', args);
  assert.equal(r.isError, undefined);
  const list = await admin('/api/bookings');
  assert.equal(list[0].id, r.structuredContent.id);
  assert.equal(list[0].name, 'Проверка Маршрута');
  const again = await call('book_viewing', args);
  assert.equal(again.isError, true);
  assert.match(again.content[0].text, /занято/);
  const log = JSON.stringify(await admin('/api/calls'));
  assert.ok(log.includes('book_viewing'));
  assert.ok(!log.includes('Проверка Маршрута') && !log.includes('765 43 21'));
});

test('no MCP_TOKEN on the server → 503, the route is off', async () => {
  const keep = process.env.MCP_TOKEN;
  process.env.MCP_TOKEN = '';
  try { assert.equal((await rpc('tools/list', {})).status, 503); } finally { process.env.MCP_TOKEN = keep; }
});
