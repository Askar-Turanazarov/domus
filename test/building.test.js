// The 12-storey building generator: deterministic, building norms, sound plans, furniture without errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generateBuilding, fillBand, SECTION, SECTION_W, CORE, TYPES } from '../public/js/building.js';
import { overlapsRooms, reachable, doorLinks, roomRect, roomView } from '../public/js/apartment.js';
import { validateAll } from '../public/js/validate.js';
import { rng } from '../public/js/furnish.js';

const catalog = JSON.parse(fs.readFileSync(new URL('../catalog.json', import.meta.url), 'utf8')).items;
const settings = { snap: 5, gap: 3, grid: 10, minPassage: 60 };
const b = generateBuilding({ catalog });
const apts = b.floorsData.flatMap(f => f.apartments);
const m2 = r => r.room.L * r.room.W / 1e4;
// a room rect on the floor plan
const onFloor = (a, r) => { const q = roomRect(r); return { x: a.at.x + q.x, y: a.at.y + q.y, w: q.w, h: q.h }; };
const hit = (p, q) => p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;

test('deterministic, and the saved demo building is up to date', () => {
  assert.equal(JSON.stringify(generateBuilding({ catalog })), JSON.stringify(b));
  const saved = JSON.parse(fs.readFileSync(new URL('../buildings/chinor-park.json', import.meta.url), 'utf8'));
  assert.deepEqual(saved, JSON.parse(JSON.stringify(b)), 'run node scripts/gen-building.mjs');
  assert.notEqual(JSON.stringify(generateBuilding({ seed: 5, furnished: false })), JSON.stringify(generateBuilding({ furnished: false })));
});

test('12 floors: a lobby with commercial units, then apartments of 1–4 rooms and studios', () => {
  assert.equal(b.floorsData.length, 12);
  assert.ok(b.floorsData[0].lobby && b.floorsData[0].commercial.length && !b.floorsData[0].apartments.length);
  for (const f of b.floorsData.slice(1)) assert.ok(f.apartments.length >= 6, `floor ${f.n}`);
  for (const t of Object.keys(TYPES)) assert.ok(apts.some(a => a.type === t), t);
  assert.deepEqual([...new Set(apts.map(a => a.no))].length, apts.length, 'unique numbers');
  assert.ok(['free', 'booked', 'sold'].every(s => apts.some(a => a.status === s)));
  // the mix varies by floor
  assert.ok(new Set(b.floorsData.slice(1).map(f => f.apartments.map(a => a.type).join())).size >= 2);
});

test('fillBand fills a band exactly within the type widths', () => {
  const rand = rng(3);
  for (const [len, ends] of [[3600, [true, true]], [1530, [true, false]], [2400, [false, true]]]) {
    const band = fillBand(len, ends, rand);
    assert.ok(band, String(len));
    assert.equal(band.reduce((s, u) => s + u.w, 0) + (band.length - 1) * 20, len);
    for (const u of band) assert.ok(u.w >= TYPES[u.type].w[0] && u.w <= TYPES[u.type].w[1], `${u.type} ${u.w}`);
  }
});

test('every floor: apartments inside the section, not over each other, the corridor or the core', () => {
  for (const f of b.floorsData.slice(1)) {
    const rects = f.apartments.flatMap(a => a.plan.map(r => ({ a: a.no, ...onFloor(a, r) })));
    for (const r of rects) {
      assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= SECTION && r.y + r.h <= SECTION_W, `floor ${f.n} apt ${r.a}`);
      assert.ok(!hit(r, CORE) && !hit(r, b.corridor), `floor ${f.n} apt ${r.a}`);
    }
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        if (rects[i].a !== rects[j].a) assert.ok(!hit(rects[i], rects[j]), `floor ${f.n}: ${rects[i].a} × ${rects[j].a}`);
      }
    }
  }
});

for (const a of apts.filter((x, i, all) => all.findIndex(y => y.type === x.type && y.w === x.w && y.side === x.side && y.corner === x.corner) === i)) {
  test(`apartment ${a.no} (${a.type} ${a.w}, ${a.side}${a.corner ? ', corner' : ''}): plan and norms`, () => {
    const rooms = a.plan, links = doorLinks(rooms);
    assert.deepEqual(overlapsRooms(rooms), []);
    assert.equal(links.filter(l => l.to === 'outside').length, 1, 'one front door');
    const front = rooms.find(r => r.id === links.find(l => l.to === 'outside').room);
    assert.equal(front.purpose, 'hall');
    assert.ok(onFloor(a, front).y + (a.side === 'north' ? front.room.W : 0) === (a.side === 'north' ? b.corridor.y - 20 : b.corridor.y + b.corridor.h + 20),
      'the front door opens to the corridor');
    assert.equal(reachable(rooms, links).size, rooms.length, 'every room is reachable');
    const living = rooms.filter(r => ['living', 'bedroom', 'kids', 'kitchen', 'kitchenLiving'].includes(r.purpose));
    for (const r of living) {
      assert.ok(r.openings.some(o => o.kind === 'window'), `${r.name}: window`);
      assert.ok(Math.min(r.room.L, r.room.W) >= 240, `${r.name}: width`);
      // windows only on the facade or the end wall
      for (const o of r.openings.filter(x => x.kind === 'window')) {
        const q = onFloor(a, r);
        const out = { north: q.y === 0, south: q.y + q.h === SECTION_W, west: q.x === 0, east: q.x + q.w === SECTION }[o.wall];
        assert.ok(out, `${r.name}: window on the ${o.wall} wall is not outside`);
      }
    }
    const main = rooms.find(r => r.purpose === 'living' || r.purpose === 'kitchenLiving');
    assert.ok(m2(main) >= (a.rooms <= 1 ? 14 : 16), `main room ${m2(main)}`);
    for (const r of rooms) {
      if (['bedroom', 'kids'].includes(r.purpose)) assert.ok(m2(r) >= 8, `${r.name} ${m2(r)}`);
      if (r.purpose === 'kitchen') assert.ok(m2(r) >= 5, `${r.name} ${m2(r)}`);
      if (r.purpose === 'bathroom' && r.name.startsWith('Ванная')) assert.ok(Math.min(r.room.L, r.room.W) >= 150 && Math.max(r.room.L, r.room.W) >= 170, r.name);
    }
    // a corner unit has a room with two windows (facade and end wall)
    const two = rooms.some(r => r.openings.filter(o => o.kind === 'window').length === 2);
    assert.equal(two, a.corner, 'corner layout');
  });
}

test('furniture of every apartment without errors; every apartment furnished', () => {
  for (const a of apts) {
    const apt = { rooms: a.plan, settings, catalog };
    const errs = a.plan.flatMap(r => [...validateAll(roomView(apt, r.id))].filter(([, e]) => e.length).map(([id, e]) => `${a.no} ${r.name} #${id}: ${e}`));
    assert.deepEqual(errs, []);
    assert.ok(a.plan.reduce((s, r) => s + r.items.length, 0) >= a.plan.length, `apartment ${a.no}`);
  }
});

test('price grows with the floor; corner units cost more per m²', () => {
  const per = a => a.price / a.area;
  const same = apts.filter(a => a.type === apts[0].type && a.w === apts[0].w && a.side === apts[0].side);
  const lo = same.reduce((x, y) => (x.floor < y.floor ? x : y)), hi = same.reduce((x, y) => (x.floor > y.floor ? x : y));
  if (lo !== hi) assert.ok(per(hi) > per(lo));
  const c = apts.find(a => a.corner), m = apts.find(a => !a.corner && a.floor === c.floor);
  assert.ok(per(c) > per(m));
});
