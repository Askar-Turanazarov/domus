// search_apartments: the filters against apartments.json.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { searchApartments } from '../../server/tools/index.js';
import { list, start } from './helpers.js';

const s = await start();
after(() => s.server.close());

test('searchApartments: free by default, cheapest first, limit', () => {
  const r = searchApartments(list, { limit: 3 });
  assert.equal(r.apartments.length, 3);
  assert.equal(r.total, list.filter(a => a.status === 'free').length);
  assert.ok(r.apartments.every((a, i, xs) => a.status === 'free' && (!i || xs[i - 1].price <= a.price)));
  assert.deepEqual(searchApartments(list, { floor: 99 }), { total: 0, apartments: [] });
});

test('search_apartments over MCP: rooms, max price, min area, floor', async () => {
  const want = list.filter(a => a.rooms === 2 && a.price <= 9e8 && a.area >= 50);
  assert.ok(want.length > 0);
  const r = await s.call('search_apartments', { rooms: 2, maxPrice: 900_000_000, minArea: 50, status: 'any' });
  assert.equal(r.structuredContent.total, want.length);
  assert.match(r.content[0].text, /^Найдено: \d+/);
  const f = await s.call('search_apartments', { floor: 5, status: 'any', limit: 100 });
  assert.equal(f.structuredContent.total, list.filter(a => a.floor === 5).length);
  assert.ok(f.structuredContent.apartments.every(a => a.floor === 5));
});

test('search_apartments: bad input is a tool error, not a crash', async () => {
  assert.equal((await s.call('search_apartments', { rooms: 'two' })).isError, true);
  assert.equal((await s.call('search_apartments', { maxPrice: -1 })).isError, true);
});
