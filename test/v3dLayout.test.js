// The 3D controls live in the toolbar and the ⚙ panel above the scene, not over the picture; the 3D code still finds them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../pages/index.html', import.meta.url), 'utf8');
const between = (from, to) => html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));

test('every 3D control the scripts look up is on the page once', () => {
  for (const id of ['v3dMoreBtn', 'v3dPanel', 'v3dPanelClose', 'v3dScene', 'hint3dBtn', 'aoBtn', 'finishSeg', 'lightSeg', 'lampBtn',
    'ceilSel', 'perfSel', 'heightBox', 'heightSel', 'openAllBtn', 'snap3dBtn', 'share3dBtn', 'fs3dBtn', 'exitFsBtn',
    'cross3d', 'dist3d', 'anim3d', 'tex3dNote', 'tex3dBtns', 'hint3d', 'room3d', 'walkOverlay', 'joystick']) {
    assert.equal(html.split(`id="${id}"`).length - 1, 1, id);
  }
});

test('buttons and settings are outside the scene area, the in-scene overlays inside it', () => {
  const scene = between('<div class="v3d-scene"', '<button type="button" class="hint-toggle"');
  for (const id of ['v3dMoreBtn', 'perfSel', 'ceilSel', 'finishSeg', 'lightSeg', 'snap3dBtn']) assert.ok(!scene.includes(`id="${id}"`), id);
  for (const id of ['hint3d', 'room3d', 'joystick', 'walkOverlay', 'dist3d']) assert.ok(scene.includes(`id="${id}"`), id);
  assert.ok(!html.includes('hud-top'), 'the old overlay toolbar is gone');
});
