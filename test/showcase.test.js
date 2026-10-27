// New-building showcase on the server: a request with apartmentRef, statuses computed from the base (D-15).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateOrder } from '../server/validateOrder.js';
import { applyStatuses } from '../server/buildings.js';

// The routes on a real server (port 0) over a PGlite base in memory (loaded before the tests are declared).
process.env.ADMIN_TOKEN = 'showcase-test-token';
const { default: app, db } = await import('../server.js');
const server = app.listen(0);
after(() => server.close());

const ref = { building: 'chinor-park', floor: 2, apt: 1 };
const request = (patch = {}) => ({ name: 'Askar', phone: '+998 90 123 45 67', comment: '', lang: 'ru', apartmentRef: ref, ...patch });

test('validateOrder: a request for an apartment needs no furniture', () => {
  const r = validateOrder(request());
  assert.equal(r.ok, true);
  assert.deepEqual(r.order.apartmentRef, ref);
  assert.equal('room' in r.order, false);
  assert.equal('rooms' in r.order, false);
  // without apartmentRef an empty order is still refused
  assert.equal(validateOrder(request({ apartmentRef: undefined })).ok, false);
});

test('validateOrder: apartmentRef is checked and cut to its fields', () => {
  for (const bad of [{ ...ref, building: '../order' }, { ...ref, floor: 0 }, { ...ref, apt: 1.5 }, { ...ref, apt: '1' }, 'x', []]) {
    assert.equal(validateOrder(request({ apartmentRef: bad })).field, 'apartmentRef', JSON.stringify(bad));
  }
  assert.deepEqual(validateOrder(request({ apartmentRef: { ...ref, price: 1, evil: 1 } })).order.apartmentRef, ref);
});

test('applyStatuses: the manager\'s status wins, unknown values are ignored', () => {
  const b = { id: 'b', floorsData: [{ apartments: [{ no: 1, status: 'free' }, { no: 2, status: 'free' }, { no: 3, status: 'sold' }] }] };
  applyStatuses(b, { b: { 1: 'sold', 2: 'nonsense' }, other: { 3: 'free' } });
  assert.deepEqual(b.floorsData[0].apartments.map(a => a.status), ['sold', 'free', 'sold']);
});

const base = () => `http://127.0.0.1:${server.address().port}`;
const status = async no => (await (await fetch(`${base()}/api/buildings/chinor-park`)).json())
  .floorsData.flatMap(f => f.apartments).find(a => a.no === no).status;

test('the building shows the status from the base: no manual PATCH any more, a sale shows at once', async () => {
  const res = await fetch(`${base()}/api/buildings/chinor-park/apartments/1`, { method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.ADMIN_TOKEN }, body: '{"status":"sold"}' });
  assert.equal(res.status, 404);
  assert.equal(await status(1), 'free');
  await db.query('UPDATE apartments SET sold_at = now() WHERE no = 1');
  assert.equal(await status(1), 'sold');
  // the generated file itself is untouched
  const file = JSON.parse(readFileSync(new URL('../buildings/chinor-park.json', import.meta.url), 'utf8'));
  assert.equal(file.floorsData.flatMap(f => f.apartments).find(a => a.no === 1).status, 'free');
  await db.query('UPDATE apartments SET sold_at = NULL WHERE no = 1');
});

test('GET /api/buildings lists the demo building; a bad id is 404', async () => {
  const list = await (await fetch(`${base()}/api/buildings`)).json();
  assert.ok(list.some(b => b.id === 'chinor-park' && b.floors === 12 && b.apartments > 50));
  assert.equal((await fetch(`${base()}/api/buildings/..%2Fpackage`)).status, 404);
});
