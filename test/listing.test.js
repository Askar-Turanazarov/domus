// The new-building apartments (apartments.json): a sound list that matches the plans, and the server reads it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyListing, APT_STATUSES } from '../server/buildings.js';
import { mirrorFileStatuses } from './support/db.js';

const read = f => JSON.parse(readFileSync(new URL('../' + f, import.meta.url), 'utf8'));
const list = read('apartments.json').apartments;
const bld = read('buildings/chinor-park.json');
const planned = bld.floorsData.flatMap(f => f.apartments.map(a => ({ ...a, floor: f.n })));
// the server is loaded before the tests are declared: a top-level await between them would let the runner start early
const { default: app, db } = await import('../server.js');
await mirrorFileStatuses(db);   // statuses come from the base: give it the file's ones
const server = app.listen(0);
after(() => server.close());

test('apartments.json: every apartment of the plans once, with sane fields', () => {
  assert.deepEqual(list.map(x => x.no).sort((a, b) => a - b), planned.map(a => a.no).sort((a, b) => a - b));
  for (const x of list) {
    const a = planned.find(p => p.no === x.no);
    assert.equal(x.building, bld.id, `№${x.no}`);
    assert.equal(x.floor, a.floor, `№${x.no} floor`);
    assert.ok(Number.isInteger(x.rooms) && x.rooms >= 0 && x.rooms <= 6, `№${x.no} rooms`);
    assert.ok(x.area >= 15 && x.area <= 250, `№${x.no} area`);
    assert.ok(Number.isInteger(x.price) && x.price > 1e8, `№${x.no} price`);
    assert.ok(APT_STATUSES.includes(x.status), `№${x.no} status`);
  }
  assert.ok(APT_STATUSES.every(s => list.some(x => x.status === s)));
});

test('applyListing: the list wins; other buildings, wrong floors and bad values are ignored', () => {
  const b = { id: 'b', floorsData: [{ n: 2, apartments: [
    { no: 1, floor: 2, rooms: 1, area: 40, price: 5e8, status: 'free' },
    { no: 2, floor: 2, rooms: 2, area: 60, price: 7e8, status: 'free' },
    { no: 3, floor: 2, rooms: 3, area: 80, price: 9e8, status: 'free' }] }] };
  applyListing(b, [
    { building: 'b', no: 1, floor: 2, rooms: 1, area: 41.5, price: 6e8, status: 'sold' },
    { building: 'b', no: 2, floor: 5, price: 1, status: 'sold' },
    { building: 'b', no: 3, floor: 2, area: 'big', price: -1, status: 'gone' },
    { building: 'x', no: 3, floor: 2, status: 'booked' }]);
  assert.deepEqual(b.floorsData[0].apartments.map(a => [a.area, a.price, a.status]),
    [[41.5, 6e8, 'sold'], [60, 7e8, 'free'], [80, 9e8, 'free']]);
});

test('GET /api/buildings/:id shows the values from apartments.json', async () => {
  const b = await (await fetch(`http://127.0.0.1:${server.address().port}/api/buildings/${bld.id}`)).json();
  const shown = b.floorsData.flatMap(f => f.apartments);
  for (const x of list) {
    const a = shown.find(s => s.no === x.no);
    assert.deepEqual([a.floor, a.rooms, a.area, a.price, a.status], [x.floor, x.rooms, x.area, x.price, x.status], `№${x.no}`);
  }
});
