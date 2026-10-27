// get_apartment: one card by number, an unknown number is a clear error.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApartment } from '../../server/tools/index.js';
import { list, start } from './helpers.js';

const s = await start();
after(() => s.close());

test('get_apartment: №1 is exactly the apartments.json entry plus the price per m²', async () => {
  const a1 = list.find(a => a.no === 1);
  const { building, ...want } = a1;
  const r = await s.call('get_apartment', { no: 1 });
  assert.deepEqual(r.structuredContent, { ...want, pricePerM2: Math.round(a1.price / a1.area) });
  assert.match(r.content[0].text, /^№1: /);
});

test('get_apartment: an unknown number → a tool error in plain words; bad input → error', async () => {
  const r = await s.call('get_apartment', { no: 9999 });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Квартира №9999 не найдена/);
  for (const no of [0, 1.5, '1', [1, 2]]) assert.equal((await s.call('get_apartment', { no })).isError, true, JSON.stringify(no));
});

test('the old names are gone: get_apartments and booking_view', async () => {
  const names = (await (await s.rpc('tools/list', {})).json()).result.tools.map(t => t.name);
  assert.deepEqual(names, ['search_apartments', 'get_apartment', 'calc_mortgage', 'book_viewing']);
});

test('getApartment: null for an unknown number', () => {
  assert.equal(getApartment(list, 9999), null);
});
