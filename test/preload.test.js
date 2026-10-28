// The modulepreload lists in the pages match the imports (after a new import: npm run preload).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { update, lists } from '../scripts/preload.js';

test('the preload lists in index.html and building.html are up to date', () => {
  for (const [page, r] of Object.entries(update(false))) assert.ok(r.same, `${page}: run npm run preload`);
});

test('the planner preloads its own modules at once and the 3D ones (three included) on demand', () => {
  const { now, lazy } = lists('index.html');
  assert.ok(now.includes('/js/state.js') && !now.includes('/js/main.js'));
  assert.ok(!now.some(u => u.startsWith('/js/3d/')), 'no 3D code before it is needed');
  assert.ok(lazy.includes('/js/3d/scene3d.js') && lazy.includes('/vendor/three/build/three.module.js'));
  assert.ok(lazy.every(u => !now.includes(u)));
  for (const u of [...now, ...lazy]) assert.ok(u.startsWith('/vendor/') || fs.existsSync(new URL('../public' + u, import.meta.url)), u);
  const html = fs.readFileSync(new URL('../pages/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('type="importmap"') < html.indexOf('modulepreload'), 'the import map comes first');
});
