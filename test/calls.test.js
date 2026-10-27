// GET /api/calls: the MCP call log for the manager page (ADMIN_TOKEN), newest first, at most 200.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'fsp3d-calls-'));
const file = join(dir, 'mcp-calls.jsonl');
process.env.DATA_DIR = dir;
process.env.CALLS_FILE = file;
process.env.ADMIN_TOKEN = 'calls-test-admin-token';
const { default: app } = await import('../server.js');
const server = app.listen(0);
after(() => server.close());
const get = (token = process.env.ADMIN_TOKEN) => fetch(`http://127.0.0.1:${server.address().port}/api/calls`,
  { headers: token ? { Authorization: 'Bearer ' + token } : {} });
const ev = i => JSON.stringify({ at: new Date(Date.UTC(2026, 9, 19, 10, 0, i)).toISOString(), type: 'call', tool: 'search_apartments', ok: true, ms: 3, args: { rooms: 2 }, msg: 'Найдено: ' + i });

test('without the manager token → 401', async () => {
  for (const t of ['', 'wrong']) assert.equal((await get(t)).status, 401);
});

test('no log file → an empty list (the page shows «Вызовов пока нет»)', async () => {
  rmSync(file, { force: true });
  const res = await get();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), []);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('newest first, a broken line skipped, denied events kept, only known fields', async () => {
  writeFileSync(file, [ev(1), '{ broken', JSON.stringify({ at: '2026-10-19T10:00:01.500Z', type: 'denied', reason: 'no_token', extra: 'x' }), ev(2)].join('\n') + '\n');
  const list = await (await get()).json();
  assert.deepEqual(list.map(e => e.type + (e.msg || e.reason)), ['callНайдено: 2', 'deniedno_token', 'callНайдено: 1']);
  assert.equal('extra' in list[1], false);
  // lines logged in Russian only come with the uz / en texts read back (server/tools/logText.js)
  assert.deepEqual(list[0].msgs, { ru: 'Найдено: 2', uz: 'Topildi: 2', en: 'Found: 2' });
  assert.equal(list[1].msgs, undefined);
});

test('at most the last 200 events', async () => {
  writeFileSync(file, Array.from({ length: 250 }, (_, i) => ev(i % 60)).join('\n') + '\n');
  const list = await (await get()).json();
  assert.equal(list.length, 200);
});

test('the page polls every 3 s and has the empty text', () => {
  const js = readFileSync(new URL('../public/js/calls.js', import.meta.url), 'utf8');
  assert.match(js, /EVERY_MS = 3000/);
  assert.match(js, /setInterval\(load, EVERY_MS\)/);
  assert.match(readFileSync(new URL('../public/calls.html', import.meta.url), 'utf8'), /Вызовов пока нет/);
});

test('sorted by time, not by line: a refused call written a moment late still lands in its place', async () => {
  writeFileSync(file, [ev(1), ev(3), JSON.stringify({ at: new Date(Date.UTC(2026, 9, 19, 10, 0, 2)).toISOString(), type: 'call', tool: 'book_viewing', ok: false, msg: 'late' })].join('\n') + '\n');
  assert.deepEqual((await (await get()).json()).map(e => e.msg), ['Найдено: 3', 'late', 'Найдено: 1']);
});
