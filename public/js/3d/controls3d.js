// Camera controls: Overview (orbit with wall cutaway) and Walk (first person with collisions).
import { keysTo3d } from '../pane.js';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { state, itemName } from '../state.js';
import { walkMap } from '../walkMap.js';
import { t, getLang } from '../i18n.js';

const NORMALS = {
  north: new THREE.Vector3(0, 0, -1), south: new THREE.Vector3(0, 0, 1),
  west: new THREE.Vector3(-1, 0, 0), east: new THREE.Vector3(1, 0, 0)
};

const RADIUS = 0.25;       // player radius, m
const FEET = 50;           // cm: structure lower than this is "in front of the feet" for the distance HUD
const WALK = 1.4, RUN = 3; // m/s

let camera, container, orbit, plc, overlay;
const keys = new Set();
const downAt = new Map();
// active = walking without pointer lock (touch, or a browser that refuses the lock).
export const touchInput = { f: 0, r: 0, active: false };
// The apartment in the scene: { rooms: [{ id, doc, shell, x, z }], bounds: { x, z, w, d, H } (m),
// doorOpen(roomId, doorId), openDoor(roomId, doorId), useDoor(roomId, doorId), onEnter(roomId) }.
let apt = null;
let map = null;             // walkMap of the apartment, rebuilt lazily
let here = null;            // id of the room the camera stands in
let mode = 'orbit';
const tmp = new THREE.Vector3();
let personH = 170;          // cm, eyes ≈ 93 % of the height
try { personH = Number(localStorage.getItem('fsp3d.height')) || 170; } catch { /* ignore */ }
const HEIGHTS = [120, 150, 155, 160, 165, 170, 175, 180, 185, 190, 195, 200];
const PRESETS = { 120: 'v3d.child', 165: 'v3d.woman', 180: 'v3d.man' };
let distAt = 0;
let pushed = null;          // the off-plan door the walker leans on (used once per contact)
let locked = false;         // pointer lock state, see the lock / unlock listeners

export function initControls(cam, dom, el) {
  camera = cam;
  container = el;
  orbit = new OrbitControls(camera, dom);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.08;
  orbit.minDistance = 0.5;
  orbit.maxDistance = 20;
  orbit.maxPolarAngle = Math.PI / 2 - 0.02;   // never below the floor

  plc = new PointerLockControls(camera, dom);
  overlay = el.querySelector('#walkOverlay');
  overlay.addEventListener('click', () => {
    if (isTouch()) return startFree();
    try { plc.lock(); } catch { return startFree(); }
    // No lock shortly after the click (denied / unsupported) → walk without it.
    setTimeout(() => { if (mode === 'walk' && !plc.isLocked && !touchInput.active) startFree(); }, 400);
  });
  document.addEventListener('pointerlockerror', () => { if (mode === 'walk') startFree(); });
  // three.js fires lock/unlock before updating plc.isLocked, so the HUD uses its own flag.
  plc.addEventListener('lock', () => { locked = true; document.activeElement?.blur(); touchInput.active = false; overlay.hidden = true; updateHint(); });
  plc.addEventListener('unlock', () => { locked = false; if (mode === 'walk' && !touchInput.active) overlay.hidden = false; updateHint(); });

  // Mouse drag look when walking without pointer lock.
  let drag = null;
  dom.addEventListener('pointerdown', e => {
    if (mode === 'walk' && touchInput.active && e.pointerType === 'mouse') drag = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener('pointermove', e => {
    if (!drag) return;
    look(e.clientX - drag.x, e.clientY - drag.y);
    drag = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener('pointerup', () => { drag = null; });

  const typing = e => e.target instanceof Element && e.target.closest('input, textarea, select');
  window.addEventListener('keydown', e => {
    if (mode !== 'walk' || typing(e) || !keysTo3d()) return;
    if (e.code === 'Escape' && touchInput.active) { stopFree(); return; }
    if (!keys.has(e.code)) downAt.set(e.code, performance.now());
    keys.add(e.code);
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
  });
  // A short tap still counts as a ~150 ms step.
  window.addEventListener('keyup', e => {
    const held = performance.now() - (downAt.get(e.code) || 0);
    setTimeout(() => keys.delete(e.code), Math.max(0, 150 - held));
  });
  window.addEventListener('blur', () => keys.clear());

  el.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

  const sel = el.querySelector('#heightSel');
  sel.addEventListener('change', () => {
    personH = Number(sel.value);
    try { localStorage.setItem('fsp3d.height', personH); } catch { /* ignore */ }
    map = null;
    if (apt && mode === 'walk') camera.position.y = eyeHeight();
    sel.blur();   // WASD / arrows must move the person, not the select
  });
}

function fillHeights() {
  const sel = container.querySelector('#heightSel');
  if (!HEIGHTS.includes(personH)) personH = 170;
  sel.innerHTML = HEIGHTS.map(h => `<option value="${h}">${h} ${t('unit.cm')}${PRESETS[h] ? ' · ' + t(PRESETS[h]) : ''}</option>`).join('');
  sel.value = personH;
}

// New apartment data. The overview is re-aimed when its outline changed; a walker stays where he is unless
// that place became blocked.
export function setApartment(a, resetView) {
  apt = a;
  map = null;
  if (!apt.rooms.some(r => r.id === here)) here = null;
  if (resetView) { if (mode === 'orbit') overview(); else spawn(); }
  else if (mode === 'walk' && mapOf().blocked(camera.position.x * 100, camera.position.z * 100)) spawn();
}

const mapOf = () => (map ||= walkMap(apt.rooms.map(r => r.doc), {
  radius: RADIUS * 100, personH, feet: FEET, doorOpen: (r, d) => apt.doorOpen(r, d)
}));
const entryOf = id => apt.rooms.find(r => r.id === id) || null;

function overview() {
  const { x, z, w, d, H } = apt.focus || apt.bounds;
  orbit.target.set(x + w / 2, H * 0.3, z + d / 2);
  // A steep view, so partitions hide less of the rooms behind them.
  const dist = Math.max(w, d) * 0.9 + 1;
  camera.position.set(x + w / 2 + dist * 0.45, H + dist * 0.95, z + d / 2 + dist * 0.65);
  orbit.update();
}

export function setMode(next) {
  mode = next;
  container.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  orbit.enabled = mode === 'orbit';
  keys.clear();
  if (mode === 'orbit') {
    if (plc.isLocked) plc.unlock();
    touchInput.active = false;
    overlay.hidden = true;
    overview();
  } else {
    touchInput.active = false;
    spawn();
    overlay.hidden = false;
  }
  updateHint();
}

export function updateHint() {
  fillHeights();
  container.querySelector('#heightBox').hidden = mode !== 'walk';
  const walking = mode === 'walk' && (locked || touchInput.active);
  container.querySelector('#dist3d').hidden = !walking;
  container.querySelector('#cross3d').hidden = !walking;
  const key = mode === 'orbit' ? (isTouch() ? 'v3d.orbitTouch' : 'v3d.orbitHint') : isTouch() ? 'v3d.touchHint'
    : touchInput.active ? 'v3d.dragHint' : 'v3d.walkHint';
  container.querySelector('#hint3d').textContent = [t(key), t('anim.hint'), t(isTouch() ? 'v3d.keysTouch' : 'v3d.keys')].join(' · ');
}

function startFree() {
  document.activeElement?.blur();   // keys must not re-trigger HUD buttons
  touchInput.active = true;
  overlay.hidden = true;
  updateHint();
}

function stopFree() {
  touchInput.active = false;
  touchInput.f = touchInput.r = 0;
  keys.clear();
  overlay.hidden = false;
  updateHint();
}

export const isTouch = () => matchMedia('(pointer: coarse)').matches;

const eyeHeight = () => {
  const r = entryOf(here) || entryOf(state.activeRoomId) || apt.rooms[0];
  return Math.min(personH * 0.93 / 100, r.doc.room.H / 100 - 0.15);
};

const blocked = (x, z) => mapOf().blocked(x * 100, z * 100);

// Start in the active room just inside its first door, else at the nearest free point to its centre.
function spawn() {
  const r = entryOf(state.activeRoomId) || apt.rooms[0];
  const L = r.doc.room.L / 100, W = r.doc.room.W / 100;
  const cands = [];
  const door = (r.doc.openings || []).find(o => o.kind === 'door');
  if (door) {
    const c = (door.offset + door.width / 2) / 100, inset = door.width / 100 + 0.3;
    cands.push({ north: [c, inset], south: [c, W - inset], west: [inset, c], east: [L - inset, c] }[door.wall]);
  }
  for (let d = 0; d < Math.max(L, W); d += 0.1) {
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) cands.push([L / 2 + Math.cos(a) * d, W / 2 + Math.sin(a) * d]);
  }
  const [lx, lz] = cands.find(([x, z]) => !blocked(r.x + x, r.z + z)) || [L / 2, W / 2];
  here = r.id;
  camera.position.set(r.x + lx, eyeHeight(), r.z + lz);
  // Look towards the room centre; from the centre itself look at the north wall.
  let tx = L / 2 - lx, tz = W / 2 - lz;
  if (Math.hypot(tx, tz) < 0.3) { tx = 0; tz = -1; }
  camera.lookAt(r.x + lx + tx, eyeHeight() * 0.9, r.z + lz + tz);
}

// Move with sliding along obstacles: try X and Z separately. A closed door in the way is pushed open;
// stepping into another room makes it the active one.
function walk(dt) {
  const active = plc.isLocked || touchInput.active;
  if (!active) return;
  let f = touchInput.f, r = touchInput.r;
  if (keys.has('KeyW') || keys.has('ArrowUp')) f += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) f -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) r += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) r -= 1;
  const len = Math.hypot(f, r);
  if (len < 0.01) return;
  const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? RUN : WALK) * dt / Math.max(1, len);
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  fwd.y = 0; fwd.normalize();
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const dx = (fwd.x * f + right.x * r) * speed, dz = (fwd.z * f + right.z * r) * speed;
  const pos = camera.position;
  const door = mapOf().closedDoorAt((pos.x + dx) * 100, (pos.z + dz) * 100);
  if (door) apt.openDoor(door.room, door.door);
  const bx = blocked(pos.x + dx, pos.z), bz = blocked(pos.x, pos.z + dz);
  if (!bx) pos.x += dx;
  if (!bz) pos.z += dz;
  // Pushing into a door that leads off the plan (street, lift, a neighbour): use it once per contact.
  const out = (bx || bz) && mapOf().outerDoorAt((pos.x + (fwd.x * f + right.x * r) / len * 0.1) * 100, (pos.z + (fwd.z * f + right.z * r) / len * 0.1) * 100);
  const key = out ? out.room + ':' + out.door : null;
  if (key && key !== pushed) apt.useDoor?.(out.room, out.door);
  pushed = key;
  const id = mapOf().roomIdAt(pos.x * 100, pos.z * 100);
  if (id && id !== here) {
    here = id;
    if (id !== state.activeRoomId) apt.onEnter(id);
  }
  pos.y = eyeHeight();
}

// Rotate the view by a screen delta (touch look).
const euler = new THREE.Euler(0, 0, 0, 'YXZ');
export function look(dx, dy) {
  euler.setFromQuaternion(camera.quaternion);
  euler.y -= dx * 0.005;
  euler.x = Math.max(-1.4, Math.min(1.4, euler.x - dy * 0.005));
  camera.quaternion.setFromEuler(euler);
}

// Dollhouse cutaway: hide the walls of every room that face the camera, and the ceilings from above.
// Returns true when something was shown or hidden (the shadows have to be redrawn).
function cutaway() {
  if (!apt) return false;
  let changed = false;
  const vis = (o, v) => { if (o.visible !== v) { o.visible = v; changed = true; } };
  const showAll = mode !== 'orbit';
  // Overview of an embedded apartment: the corridor / lobby and the floor around are hidden.
  const only = !showAll && apt.focus;
  const ctx = apt.context?.();
  if (ctx) vis(ctx, !only);
  for (const r of apt.rooms) {
    if (r.group) vis(r.group, !(only && apt.skip?.has(r.id)));
    if (!r.shell) continue;
    const { L, W, H } = r.shell.size;
    for (const [side, group] of Object.entries(r.shell.walls)) {
      const c = side === 'north' ? tmp.set(L / 2, 0, 0) : side === 'south' ? tmp.set(L / 2, 0, W)
        : side === 'west' ? tmp.set(0, 0, W / 2) : tmp.set(L, 0, W / 2);
      c.x += r.x; c.z += r.z;
      const outside = camera.position.clone().sub(c).dot(NORMALS[side]) > 0;
      vis(group, showAll || !outside);
    }
    vis(r.shell.ceiling, showAll || camera.position.y < H);
    if (r.shell.skies === undefined) {
      r.shell.skies = [];
      r.shell.group.traverse(o => { if (o.userData.sky || o.name === 'cornerShadeUpper') r.shell.skies.push(o); });
    }
    for (const sky of r.shell.skies) vis(sky, showAll);
  }
  return changed;
}

// One frame of movement; true when walls or ceilings were shown or hidden.
export function update(dt) {
  if (mode === 'orbit') orbit.update(); else walk(dt);
  const changed = cutaway();
  if (mode === 'walk' && performance.now() - distAt > 100) { distAt = performance.now(); showDistance(); }
  return changed;
}

// Straight distance along the floor from the person's feet (camera projected down) in the looking direction
// to the first furniture footprint, structure or wall; open doorways let it through into the next room.
function showDistance() {
  const el = container.querySelector('#dist3d');
  if (el.hidden || !apt) return;
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) return;
  fwd.normalize();
  const hit = mapOf().ray(camera.position.x * 100, camera.position.z * 100, fwd.x, fwd.z);
  if (!hit) return;
  const d = hit.d / 100;
  const m = d < 0.01 ? t('v3d.distTouch') : d.toLocaleString(getLang(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const cm = Math.round(hit.d);
  const text = hit.item ? t('v3d.distItem', { name: itemName(hit.item), m })
    : hit.ob ? t('v3d.distItem', { name: t('ob.' + hit.ob.kind), m })
    : t('v3d.distWall', { wall: t('wallShort.' + hit.wall), m });
  el.innerHTML = '';
  el.append(text, Object.assign(document.createElement('small'), { textContent: `${cm} ${t('unit.cm')} · ${t('v3d.fromFeet')}` }));
}

export const getMode = () => mode;

// Walk at once without the "click to enter" card (embedded floor view): keys + mouse drag, a click on the
// card later still takes the pointer lock.
export function walkNow() {
  if (mode === 'walk' && !plc.isLocked) startFree();
}

// Leaving the 3D view: release the mouse and stop walking.
export function release() {
  if (!plc) return;
  if (plc.isLocked) plc.unlock();
  touchInput.active = false;
  touchInput.f = touchInput.r = 0;
  keys.clear();
  if (mode === 'walk') overlay.hidden = false;
  updateHint();
}
