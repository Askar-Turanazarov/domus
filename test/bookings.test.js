// GET /api/bookings: the viewings from the base for the manager page (ADMIN_TOKEN), newest first.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { legacyStore } from '../server/db/legacy.js';

process.env.ADMIN_TOKEN = 'bookings-test-token';
const { default: app, db } = await import('../server.js');
const server = app.listen(0);
after(() => server.close());
const store = legacyStore(db);
const get = (token = process.env.ADMIN_TOKEN) => fetch(`http://127.0.0.1:${server.address().port}/api/bookings`,
  { headers: token ? { Authorization: 'Bearer ' + token } : {} });

const b = (createdAt, no) => ({ id: randomUUID(), no, name: 'Имя ' + no, phone: '+998 90 123 45 67', datetime: '2026-12-01T15:00+05:00', createdAt });

test('without the manager token → 401, the names and phones stay hidden', async () => {
  for (const t of ['', 'wrong']) assert.equal((await get(t)).status, 401);
});

test('no viewings → an empty list (the page shows «Заявок пока нет»)', async () => {
  const res = await get();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), []);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('the bookings, newest first, only the shown fields, the phone in its normal form', async () => {
  const old = await store.addBooking(b('2026-10-19T10:00:00.000Z', 1));
  const recent = await store.addBooking(b('2026-10-19T12:00:00.000Z', 28));
  const list = await (await get()).json();
  assert.deepEqual(list.map(x => x.id), [recent.id, old.id]);
  assert.deepEqual(Object.keys(list[0]).sort(), ['createdAt', 'datetime', 'id', 'name', 'no', 'phone']);
  assert.deepEqual(list[0], { ...recent, phone: '+998901234567' });
  // a new booking shows up on the next poll, nothing cached
  const newest = await store.addBooking(b('2026-10-19T13:00:00.000Z', 3));
  assert.equal((await (await get()).json())[0].id, newest.id);
});

test('the base fails → 500, not an empty list', async () => {
  const keep = db.query;
  db.query = async () => { throw new Error('down'); };
  try { assert.equal((await get()).status, 500); } finally { db.query = keep; }
});

test('the page polls every 3 s and has the empty text', () => {
  const js = readFileSync(new URL('../public/js/bookings.js', import.meta.url), 'utf8');
  assert.match(js, /EVERY_MS = 3000/);
  assert.match(js, /setInterval\(load, EVERY_MS\)/);
  assert.match(readFileSync(new URL('../pages/bookings.html', import.meta.url), 'utf8'), /Заявок пока нет/);
});
