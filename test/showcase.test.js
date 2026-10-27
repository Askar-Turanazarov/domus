// New-building showcase on the server: a request with apartmentRef, statuses by the manager (PATCH, Bearer token).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateOrder } from '../server/validateOrder.js';
import { applyStatuses } from '../server/buildings.js';

// The routes on a real server (port 0) with a temporary data folder (loaded before the tests are declared).
const dataDir = mkdtempSync(join(tmpdir(), 'fsp3d-'));
process.env.DATA_DIR = dataDir;
process.env.ADMIN_TOKEN = 'showcase-test-token';
const { default: app } = await import('../server.js');
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
const patch = (apt, body, token = process.env.ADMIN_TOKEN, id = 'chinor-park') => fetch(`${base()}/api/buildings/${id}/apartments/${apt}`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
  body: JSON.stringify(body)
});
const status = async no => (await (await fetch(`${base()}/api/buildings/chinor-park`)).json())
  .floorsData.flatMap(f => f.apartments).find(a => a.no === no).status;

test('PATCH apartment status: token, status and apartment are checked; the building shows the new status', async () => {
  assert.equal((await patch(1, { status: 'sold' }, '')).status, 401);
  assert.equal((await patch(1, { status: 'sold' }, 'wrong')).status, 401);
  assert.equal((await patch(1, { status: 'gone' })).status, 400);
  assert.equal((await patch(99999, { status: 'sold' })).status, 404);
  assert.equal((await patch(1, { status: 'sold' }, undefined, 'nope')).status, 404);
  assert.equal((await patch('1x', { status: 'sold' })).status, 404);
  const before = await status(1);
  const next = before === 'booked' ? 'sold' : 'booked';
  const res = await patch(1, { status: next });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { no: 1, status: next });
  assert.equal(await status(1), next);
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'building-status.json'), 'utf8')), { 'chinor-park': { 1: next } });
  // the generated file itself is untouched
  const file = JSON.parse(readFileSync(new URL('../buildings/chinor-park.json', import.meta.url), 'utf8'));
  assert.equal(file.floorsData.flatMap(f => f.apartments).find(a => a.no === 1).status, before);
});

test('GET /api/buildings lists the demo building; a bad id is 404', async () => {
  const list = await (await fetch(`${base()}/api/buildings`)).json();
  assert.ok(list.some(b => b.id === 'chinor-park' && b.floors === 12 && b.apartments > 50));
  assert.equal((await fetch(`${base()}/api/buildings/..%2Fpackage`)).status, 404);
});
