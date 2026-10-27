// The token gate and the HTTP edges of the MCP server.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHttpServer, checkToken } from '../../server/mcp/index.js';
import { TOKEN, start } from './helpers.js';

const s = await start();
const broken = await start({ apartments: '/nonexistent/apartments.json', bookings: '/nonexistent/booking.json' });
after(() => { s.server.close(); broken.server.close(); });

test('a missing data file → a general tool error without the file path', async () => {
  const r = await broken.call('search_apartments', {});
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, 'Внутренняя ошибка сервера, попробуйте позже');
});

test('checkToken: only the exact Bearer token', () => {
  assert.equal(checkToken('Bearer ' + TOKEN, TOKEN), true);
  for (const h of [undefined, '', 'Bearer', 'Bearer ' + TOKEN + 'x', TOKEN.slice(1), 'Basic ' + TOKEN]) assert.equal(checkToken(h, TOKEN), false, String(h));
});

test('a missing or short token refuses to start', () => {
  for (const token of [undefined, '', 'x'.repeat(31)]) assert.throws(() => createHttpServer({ token }), /MCP_TOKEN/);
});

test('without the token or with a wrong one → 401 and nothing else', async () => {
  for (const t of ['', 'wrong'.padEnd(40, 'y')]) {
    const res = await s.rpc('tools/list', {}, t);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('www-authenticate'), 'Bearer');
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
  }
});

test('other path → 404, GET → 405, bad JSON → 400', async () => {
  const auth = { Authorization: 'Bearer ' + TOKEN };
  assert.equal((await fetch(s.url.replace('/mcp', '/other'), { headers: auth })).status, 404);
  assert.equal((await fetch(s.url, { headers: auth })).status, 405);
  assert.equal((await fetch(s.url, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{' })).status, 400);
});

// a raw request: fetch would normalise the path or refuse to cut the body
const raw = text => new Promise(ok => {
  const c = net.connect(new URL(s.url).port, '127.0.0.1', () => c.end(text));
  let out = '';
  c.on('data', d => { out += d; }).on('close', () => ok(out)).on('error', () => ok(out));
});

test('a malformed path (//) or a body cut mid-way does not bring the server down', async () => {
  assert.match(await raw('GET // HTTP/1.1\r\nHost: x\r\n\r\n'), /^HTTP\/1\.1 404/);
  await raw(`POST /mcp HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"jsonrpc"`);
  const res = await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(res.status, 200, 'the server still answers');
});

test('with the token: initialize answers as «novostroyka»', async () => {
  const res = await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).result.serverInfo.name, 'novostroyka');
});
