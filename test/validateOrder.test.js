import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateOrder } from '../server/validateOrder.js';
import { createStore, createRateLimit } from '../server/orderStore.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const png = buf => 'data:image/png;base64,' + buf.toString('base64');

const order = (patch = {}) => ({
  name: ' Askar ', phone: '+998 (90) 123-45-67', comment: 'hi', lang: 'uz',
  project: { name: 'Home' }, roomName: 'Bedroom', purpose: 'bedroom',
  room: { L: 400, W: 300, H: 270, plinth: 2 },
  openings: [{ kind: 'door', wall: 'south', offset: 10, width: 80, height: 200, hinge: 'start' }],
  items: [{ type: 'wardrobe', name: 'Шкаф', w: 100, d: 60, h: 220, x: 2, y: 2, rot: 0, sections: 2, price: 2310000 }],
  estimate: 2310000,
  ...patch
});

test('a correct order passes; strings trimmed, defaults filled', () => {
  const r = validateOrder(order({ drawing: png(PNG) }));
  assert.equal(r.ok, true);
  assert.equal(r.order.name, 'Askar');
  assert.equal(r.order.items[0].elev, 0);
  assert.equal(r.order.items[0].sections, 2);
  assert.deepEqual(r.files.map(f => f[0]), ['plan.png']);
});

test('unknown fields are dropped (whitelist)', () => {
  const r = validateOrder(order({ admin: true, status: 'done', items: [{ ...order().items[0], evil: '<script>' }] }));
  assert.equal(r.ok, true);
  assert.equal('admin' in r.order, false);
  assert.equal('status' in r.order, false);
  assert.equal('evil' in r.order.items[0], false);
});

test('wrong phone, missing name, bad sizes are rejected with the field', () => {
  assert.deepEqual(validateOrder(order({ phone: 'call me' })), { ok: false, error: 'invalid_order', field: 'phone' });
  assert.equal(validateOrder(order({ name: '  ' })).field, 'name');
  assert.equal(validateOrder(order({ room: { L: 20, W: 300, H: 270 } })).field, 'room.room.L');
  assert.equal(validateOrder(order({ items: [{ ...order().items[0], rot: 45 }] })).field, 'room.items[0].rot');
  assert.equal(validateOrder(order({ comment: 'x'.repeat(1001) })).field, 'comment');
  assert.equal(validateOrder(order({ items: [] })).field, 'items');
});

test('too many items / openings', () => {
  const it = order().items[0];
  assert.equal(validateOrder(order({ items: Array(201).fill(it) })).field, 'room.items');
  assert.equal(validateOrder(order({ openings: Array(51).fill(order().openings[0]) })).field, 'room.openings');
});

test('drawing: only a real PNG of at most 1.5 MB', () => {
  const big = Buffer.concat([PNG, Buffer.alloc(1.5 * 1024 * 1024)]);
  assert.equal(validateOrder(order({ drawing: png(big) })).field, 'drawing');
  assert.equal(validateOrder(order({ drawing: png(Buffer.from('GIF89a......')) })).field, 'drawing');
  assert.equal(validateOrder(order({ drawing: 'data:image/jpeg;base64,/9j/AAAA' })).field, 'drawing');
  assert.equal(validateOrder(order({ drawing: 'https://example.com/x.png' })).field, 'drawing');
});

test('rate limit: 5 per window per IP', () => {
  let now = 0;
  const hit = createRateLimit({ max: 5, windowMs: 1000, now: () => now });
  for (let i = 0; i < 5; i++) assert.equal(hit('a'), true);
  assert.equal(hit('a'), false);
  assert.equal(hit('b'), true);
  now = 1001;
  assert.equal(hit('a'), true);
});

test('store: parallel updates are all kept, no temp files left', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orders-'));
  const file = join(dir, 'order.json');
  const store = createStore(file);
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.update(o => { o.push({ id: i }); })));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).length, 20);
  assert.deepEqual(readdirSync(dir), ['order.json']);
});

test('apartment order: rooms[] with pos, no single-room fields', () => {
  const { roomName, purpose, room, openings, items, ...head } = order();
  const rooms = [
    { name: 'Hall', purpose: 'hall', pos: { x: 0, y: 0 }, room, openings, items: [] },
    { name: 'Bedroom', purpose: 'bedroom', pos: { x: 0, y: 310 }, room, openings: [], items }
  ];
  const r = validateOrder({ ...head, rooms });
  assert.equal(r.ok, true);
  assert.deepEqual(r.order.rooms.map(x => x.pos), [{ x: 0, y: 0 }, { x: 0, y: 310 }]);
  assert.equal(r.order.room, undefined);
  assert.equal(validateOrder({ ...head, rooms: [{ ...rooms[1], pos: { x: 'a', y: 0 } }] }).field, 'rooms[0].pos.x');
  assert.equal(validateOrder({ ...head, rooms: [rooms[0]] }).field, 'items', 'an empty apartment');
  assert.equal(validateOrder(order()).order.roomName, 'Bedroom', 'old single-room orders still pass');
});
