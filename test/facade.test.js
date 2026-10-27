// Facade from the apartment plans: every window once, inside the section, corner units on the ends, the entrance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { facadeOf, apartmentAt, floorAt, sideLength } from '../public/js/facade.js';

const bld = JSON.parse(fs.readFileSync(new URL('../buildings/chinor-park.json', import.meta.url), 'utf8'));
const fac = facadeOf(bld);
const apts = bld.floorsData.flatMap(f => f.apartments);
const wins = fac.bays.filter(b => b.kind === 'window');

test('every apartment window is on the facade exactly once', () => {
  const total = apts.reduce((s, a) => s + a.plan.reduce((k, r) => k + r.openings.filter(o => o.kind === 'window').length, 0), 0);
  assert.equal(wins.length, total);
  const keys = new Set(wins.map(b => [b.floor, b.side, b.x0].join('|')));
  assert.equal(keys.size, wins.length);
  for (const a of apts) assert.ok(wins.some(b => b.aptNo === a.no), `apartment ${a.no} has windows`);
});

test('bays stay inside their side and the storey', () => {
  for (const b of fac.bays) {
    assert.ok(b.x0 >= 0 && b.x1 <= sideLength(bld.section, b.side) && b.x1 > b.x0, JSON.stringify(b));
    assert.ok(b.sill >= 0 && b.sill + b.h <= fac.H, JSON.stringify(b));
  }
});

test('bays on one storey and side do not overlap', () => {
  const groups = Map.groupBy(fac.bays, b => b.floor + b.side);
  for (const list of groups.values()) {
    list.sort((p, q) => p.x0 - q.x0);
    for (let i = 1; i < list.length; i++) assert.ok(list[i].x0 >= list[i - 1].x1, JSON.stringify([list[i - 1], list[i]]));
  }
});

test('windows face the side of their apartment, corner units also the ends', () => {
  for (const b of wins) {
    const a = apts.find(q => q.no === b.aptNo);
    assert.ok(b.side === a.side || (a.corner && (b.side === 'west' || b.side === 'east')), `${a.no} ${b.side}`);
  }
  for (const a of apts.filter(q => q.corner)) assert.ok(wins.some(b => b.aptNo === a.no && (b.side === 'west' || b.side === 'east')), `corner ${a.no}`);
});

test('glazed ground floor and the entrance beside the core', () => {
  const ground = fac.bays.filter(b => b.floor === 1);
  assert.ok(ground.some(b => b.kind === 'shop') && ground.some(b => b.kind === 'lobby'));
  assert.equal(fac.entrance.side, 'south');
  const lobby = bld.floorsData[0].lobby;
  assert.ok(fac.entrance.x0 >= bld.core.x + bld.core.w && fac.entrance.x1 <= lobby.x + lobby.w);
  for (const b of ground.filter(q => q.side === 'south')) assert.ok(b.x1 <= fac.entrance.x0 || b.x0 >= fac.entrance.x1);
});

test('picking: apartment at a facade point, floor at a height', () => {
  const b = wins.find(q => q.floor === 5 && q.side === 'north');
  assert.equal(apartmentAt(fac, 5, 'north', (b.x0 + b.x1) / 2), b.aptNo);
  assert.equal(apartmentAt(fac, 1, 'north', 100), null);
  assert.equal(floorAt(fac, 10), 1);
  assert.equal(floorAt(fac, fac.level * 4 + 1), 5);
  assert.equal(floorAt(fac, fac.level * fac.floors + 1), null);
  assert.equal(floorAt(fac, -5), null);
});
