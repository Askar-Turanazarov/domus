// GET /api/bookings: the viewing bookings from booking.json for the manager page (ADMIN_TOKEN), newest first.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'fsp3d-bk-'));
const file = join(dir, 'booking.json');
process.env.DATA_DIR = dir;
process.env.BOOKING_FILE = file;
process.env.ADMIN_TOKEN = 'bookings-test-token';
const { default: app } = await import('../server.js');
const server = app.listen(0);
after(() => server.close());
const get = (token = process.env.ADMIN_TOKEN) => fetch(`http://127.0.0.1:${server.address().port}/api/bookings`,
  { headers: token ? { Authorization: 'Bearer ' + token } : {} });

const b = (id, createdAt, no) => ({ id, no, name: 'Имя ' + id, phone: '+998 90 123 45 67', datetime: '2026-12-01T15:00+05:00', createdAt });

test('without the manager token → 401, the names and phones stay hidden', async () => {
  writeFileSync(file, JSON.stringify([b('a', '2026-10-19T10:00:00.000Z', 1)]));
  for (const t of ['', 'wrong']) assert.equal((await get(t)).status, 401);
});

test('no booking.json → an empty list (the page shows «Заявок пока нет»)', async () => {
  rmSync(file, { force: true });
  const res = await get();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), []);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('the bookings, newest first, only the shown fields', async () => {
  writeFileSync(file, JSON.stringify([b('old', '2026-10-19T10:00:00.000Z', 1), { ...b('new', '2026-10-19T12:00:00.000Z', 28), extra: 'x' }]));
  const list = await (await get()).json();
  assert.deepEqual(list.map(x => x.id), ['new', 'old']);
  assert.deepEqual(Object.keys(list[0]).sort(), ['createdAt', 'datetime', 'id', 'name', 'no', 'phone']);
  // a new booking shows up on the next poll, nothing cached
  writeFileSync(file, JSON.stringify([...JSON.parse(readFileSync(file, 'utf8')), b('newest', '2026-10-19T13:00:00.000Z', 3)]));
  assert.equal((await (await get()).json())[0].id, 'newest');
});

test('a broken booking.json → 500, not an empty list', async () => {
  writeFileSync(file, '{ broken');
  assert.equal((await get()).status, 500);
  writeFileSync(file, '{"not":"a list"}');
  assert.equal((await get()).status, 500);
});

test('the page polls every 3 s and has the empty text', () => {
  const js = readFileSync(new URL('../public/js/bookings.js', import.meta.url), 'utf8');
  assert.match(js, /EVERY_MS = 3000/);
  assert.match(js, /setInterval\(load, EVERY_MS\)/);
  assert.match(readFileSync(new URL('../public/bookings.html', import.meta.url), 'utf8'), /Заявок пока нет/);
});
