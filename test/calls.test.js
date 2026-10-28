// GET /api/calls: the MCP call log (tool_calls) for the manager page (ADMIN_TOKEN), newest first, at most 200.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.ADMIN_TOKEN = 'calls-test-admin-token';
const { default: app, db } = await import('../server.js');
const server = app.listen(0);
after(() => server.close());
const get = (token = process.env.ADMIN_TOKEN) => fetch(`http://127.0.0.1:${server.address().port}/api/calls`,
  { headers: token ? { Authorization: 'Bearer ' + token } : {} });
const at = (s, ms = 0) => new Date(Date.UTC(2026, 9, 19, 10, 0, s, ms));
const add = (when, tool, ok = true, error = null, source = 'mcp') => db.query(
  'INSERT INTO tool_calls (at, source, tool, ok, error, ms, args) VALUES ($1, $2, $3, $4, $5, 3, $6)',
  [when, source, tool, ok, error, tool ? JSON.stringify({ rooms: 2 }) : null]);

test('without the manager token → 401', async () => {
  for (const t of ['', 'wrong']) assert.equal((await get(t)).status, 401);
});

test('no calls → an empty list (the page shows «Вызовов пока нет»)', async () => {
  const res = await get();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), []);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('newest first by time, denied requests kept, agent calls not shown, only known fields', async () => {
  await add(at(1), 'search_apartments');
  await add(at(3), 'get_apartment', false, 'notFound');
  await add(at(2), null, false, 'no_token');
  await add(at(4), 'search_apartments', true, null, 'agent');
  const list = await (await get()).json();
  assert.deepEqual(list.map(e => [e.type, e.tool ?? e.reason, e.ok]), [
    ['call', 'get_apartment', false], ['denied', 'no_token', undefined], ['call', 'search_apartments', true]]);
  assert.deepEqual(list[2], { at: at(1).toISOString(), type: 'call', tool: 'search_apartments', ok: true, ms: 3, args: { rooms: 2 } });
});

test('at most the last 200 events', async () => {
  for (let i = 0; i < 250; i++) await add(at(10, i), 'calc_mortgage');
  assert.equal((await (await get()).json()).length, 200);
});

test('the page polls every 3 s and has the empty text', () => {
  const js = readFileSync(new URL('../public/js/calls.js', import.meta.url), 'utf8');
  assert.match(js, /EVERY_MS = 3000/);
  assert.match(js, /setInterval\(load, EVERY_MS\)/);
  assert.match(readFileSync(new URL('../pages/calls.html', import.meta.url), 'utf8'), /Вызовов пока нет/);
});
