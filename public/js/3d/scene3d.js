// 3D view: renderer, camera, render loop. Scene units are metres (cm / 100).
import { keysTo3d } from '../pane.js';
import * as THREE from 'three';
import { t, getLang, onLangChange } from '../i18n.js';
import { state, onChange, emit, roomView, isSelected, select, setCeiling } from '../state.js';
import { rectOf } from '../geometry.js';
import { buildRoom, disposeGroup, revealParts } from './room3d.js';
import { liveRooms } from '../renderer.js';
import { doorLinks, adjacent, wallLine, posOf, roomRect, twinIds } from '../apartment.js';
import { switchRoom } from '../projects.js';
import { buildObstacles } from './obstacles3d.js';
import { buildLights, setupEnvironment, applyFixtures, lightingOf, CEILINGS, setLightTargets, tweenLights, setShadowQuality, lampCount } from './lights3d.js';
import { lampsOn, fixturesOf } from '../lighting.js';
import { buildItem, placeItem } from './models3d.js';
import { initDrag } from './drag3d.js';
import { validateAll } from '../validate.js';
import * as controls from './controls3d.js';
import * as anim from './anim3d.js';
import { initTouch } from './touch3d.js';
import { setQuality, resetPhoto, onLibLoaded, onLibMissing, libPending, photoReady, fetchLibSet, canFetchLib, PHOTO_MB, setAnisotropy, useHD } from './textures3d.js';
import { SETTINGS, PREFS, readPref, savePref, tierFor, governor, photoAuto } from './perf.js';
import { styleOf } from '../style.js';
import { footprints, contactShadows, cornerShade } from './softShadows.js';
import { updateSpotClip } from './spotClip.js';
import { toast } from '../ui.js';
import { compose, savePicture, canShareFiles } from '../snapshot.js';

let renderer, scene, camera, container, host, clock;   // host: the scene area under the 3D toolbar
let running = false;
// Every room of the apartment: { group (at pos), doc, shell, key, furniture, fkey, lights, lkey }.
const rooms3d = new Map();
let outline = '';
let mainLights = null;     // lights of the active room (the walker's): sky, sun, shadows
let foundTimer = null;
let context = null;        // static surroundings (the floor around an embedded apartment)
// Soft shadows under furniture and in the corners, on unless the viewer turned them off.
let quality = 'simple', softOn = true;
// Drawing on demand: a frame is drawn only when something changed (camera, doors, light tweens, the scene).
let dirty = true, shadowsDirty = true, visible = true, onScreen = true;
let compiling = false;   // the first shaders are compiled in parallel (compileAsync): no frame until then
const drawnWaiters = [];
/** Resolves once the next frame is on screen. */
export const nextFrame = () => new Promise(r => drawnWaiters.push(r));
const lastView = new THREE.Matrix4(), lastProj = new THREE.Matrix4();
// Device tier (perf.js): pixel ratio, shadows, anisotropy; in Auto the governor lowers it when frames are slow.
let tier = 'mid', gov = null, prevDrawn = false;
const EXPOSURE = 1.15;
// Glow of lit shades on the "high" tier: render → bloom → tone mapping (loaded only when needed).
let composer = null, bloom = null, bloomLoading = false;

export function requestRender() { dirty = true; }
const redrawShadows = () => { dirty = shadowsDirty = true; };

function init(el) {
  container = el;
  host = el.querySelector('.v3d-scene') ?? el;
  const pref = readPref();
  tier = tierFor(pref);
  setAnisotropy(SETTINGS[tier].anisotropy);
  // 2K library maps: the "high" start tier on a desktop only (phones and the mini app keep 1K, PERF-01).
  useHD(tier === 'high' && !matchMedia('(pointer: coarse)').matches && document.documentElement.dataset.mode !== 'mini');
  try {
    renderer = new THREE.WebGLRenderer({ antialias: SETTINGS[tier].antialias });
  } catch {
    el.querySelector('#hint3d').textContent = t('v3d.noWebgl');
    return false;
  }
  applyTier(tier, false);
  gov = pref === 'auto' ? governor(tier, stepTier) : null;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // AgX keeps the warm lamp light and bright windows from washing out to flat white (ACES burned them).
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = EXPOSURE;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;   // redrawn only when lights, doors or the scene change
  host.prepend(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color('#1e2235');
  setupEnvironment(renderer, scene);
  camera = new THREE.PerspectiveCamera(60, 1, 0.05, 100);
  clock = new THREE.Clock();
  controls.initControls(camera, renderer.domElement, el);
  initTouch(el, renderer.domElement);
  el.querySelectorAll('[data-quality]').forEach(b => b.addEventListener('click', () => applyQuality(b.dataset.quality, true)));
  // Photo textures unless the viewer chose Simple (fsp3d.tex) or the device is obviously weak (perf.js).
  let saved = null;
  try {
    saved = localStorage.getItem('fsp3d.tex');
    localStorage.removeItem('fsp3d.quality');   // the old key was written by the default too: not a choice
  } catch { /* ignore */ }
  if (saved !== 'simple' && saved !== 'photo') saved = photoAuto() ? 'photo' : 'simple';
  try { softOn = localStorage.getItem('fsp3d.ao') !== '0'; } catch { /* ignore */ }
  el.querySelector('#aoBtn').addEventListener('click', () => setSoft(!softOn));
  syncSoft();
  if (saved !== 'simple') applyQuality(saved);
  // The texture panel changed the photo set: reload it and switch to Photo.
  document.addEventListener('fsp3d:textures', () => { resetPhoto(); applyQuality('photo', true); });

  el.querySelector('#snap3dBtn').addEventListener('click', () => savePicture(compose(snapshotCanvas())));
  const share = el.querySelector('#share3dBtn');
  share.hidden = !canShareFiles();
  share.addEventListener('click', () => savePicture(compose(snapshotCanvas()), true));
  // Light: time of day and ceiling fixture are part of the room (saved, undoable).
  el.querySelectorAll('[data-light]').forEach(b => b.addEventListener('click', () => {
    state.lighting = { ...lightingOf(state.lighting), scene: b.dataset.light, lampsOn: null };   // the scene decides the lamps again
    emit();
  }));
  // 💡 / L: lamps on or off over the scene default.
  el.querySelector('#lampBtn').addEventListener('click', toggleLamps);
  // N: day → sunset → night.
  window.addEventListener('keydown', e => {
    if ((e.code !== 'KeyL' && e.code !== 'KeyN') || e.repeat || e.ctrlKey || e.metaKey || e.altKey || !el.offsetParent
      || e.target.closest?.('input, textarea, select') || !keysTo3d()) return;
    if (e.code === 'KeyL') toggleLamps();
    else nextScene();
  });
  lightTitles();
  onLangChange(lightTitles);
  // The finish level is the whole apartment's (it is handed over rough, white box or finished), not one room's.
  el.querySelectorAll('[data-finish]').forEach(b => b.addEventListener('click', () => {
    const finish = b.dataset.finish;
    state.style = { ...styleOf(state.style), finish };
    for (const r of state.rooms) if (r.id !== state.activeRoomId) r.style = { ...styleOf(r.style), finish };
    emit();
  }));
  // A photo-library set has arrived: rebuild the shell and furniture with it.
  // Sets arriving one after another make one rebuild, not one each.
  let libTimer = 0;
  onLibLoaded((id, ok) => {
    if (ok) {
      clearTimeout(libTimer);
      libTimer = setTimeout(() => { forget(); if (running) rebuild(); }, libPending() ? 400 : 60);
    }
    if (!libPending() && note.mode === 'lib') hideNote();
  });
  // A set the finish needs is not on disk: the server downloads it at once (photo textures are the default), on
  // obviously weak devices and static hosts the viewer is asked first.
  onLibMissing(entry => {
    if (note.dismissed.has(entry.id)) return;
    note.missing.set(entry.id, entry);
    if (autoFetch()) { if (!note.fetching) downloadMissing(); } else showMissing();
  });
  el.querySelector('#tex3dBtns').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b?.dataset.act === 'download') downloadMissing();
    else if (b?.dataset.act === 'later') {
      for (const id of note.missing.keys()) note.dismissed.add(id);
      note.missing.clear();
      hideNote();
    }
  });
  // A new ceiling type: every room gets its default layout of it (lights placed by hand are replaced).
  el.querySelector('#ceilSel').addEventListener('change', e => setCeiling(e.target.value));
  fillCeilSel();
  onLangChange(fillCeilSel);
  // A click on the floor: another room becomes active, in the active room it clears the selection.
  anim.initAnim(camera, renderer.domElement, el, id => {
    if (id !== state.activeRoomId) switchRoom(id);
    else if (state.selectedId !== null && controls.getMode() !== 'walk') select(null);
  });
  initDrag(camera, renderer.domElement, el, {
    entries: () => [...rooms3d.values()],
    active: () => rooms3d.get(state.activeRoomId) || (rooms3d.size === 1 ? [...rooms3d.values()][0] : null),
    render: () => syncSelection()   // the frame follows the dragged item
  });
  onLangChange(anim.onLang);

  fillPerfSel();
  onLangChange(fillPerfSel);
  el.querySelector('#perfSel').addEventListener('change', e => {
    const pref = e.target.value;
    savePref(pref);
    const next = tierFor(pref);
    gov = pref === 'auto' ? governor(next, stepTier) : null;
    applyTier(next);
  });
  // Pointer and keys can change highlights and hints: draw the next frame.
  for (const ev of ['pointermove', 'pointerdown', 'pointerup', 'wheel', 'keydown', 'keyup']) el.addEventListener(ev, requestRender, { passive: true });
  // Nothing is drawn while the tab is hidden or the view is scrolled away.
  document.addEventListener('visibilitychange', () => { visible = !document.hidden; dirty = true; });
  new IntersectionObserver(list => { onScreen = list[list.length - 1].isIntersecting; dirty = true; }).observe(el);
  new ResizeObserver(resize).observe(host);
  onChange(() => { if (running) rebuild(); });
  onLangChange(() => { if (running) controls.updateHint(); });
  return true;
}

function resize() {
  const w = host.clientWidth, h = host.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  if (composer) { composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(w, h); }
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  dirty = true;
}

// Pixel ratio and shadow maps of a tier; `rebuildLights` rebuilds the lights with the new shadow sizes.
function applyTier(name, rebuildLights = true) {
  tier = name;
  const s = SETTINGS[name];
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, s.pixelRatio));
  setShadowQuality(s);
  setBloom(s.bloom);
  if (!rebuildLights) return;
  resize();
  for (const e of rooms3d.values()) e.lkey = '';
  if (running) rebuild();
}

async function setBloom(on) {
  if (!on) { composer = null; dirty = true; return; }
  if (composer || bloomLoading) return;
  bloomLoading = true;
  try {
    const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }] = await Promise.all([
      import('three/addons/postprocessing/EffectComposer.js'), import('three/addons/postprocessing/RenderPass.js'),
      import('three/addons/postprocessing/UnrealBloomPass.js'), import('three/addons/postprocessing/OutputPass.js')]);
    if (!SETTINGS[tier].bloom) return;
    const c = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
    c.addPass(new RenderPass(scene, camera));
    // Only what is brighter than white glows: lit shades, the sun on glass; walls and furniture stay crisp.
    bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.18, 0.4, 1.3);
    c.addPass(bloom);
    c.addPass(new OutputPass());
    composer = c;
    resize();
  } catch (err) {
    console.warn('bloom off', err);
  } finally {
    bloomLoading = false;
  }
}

function stepTier(name, dir) {
  applyTier(name);
  if (dir < 0) toast(t('perf.down'));
}

function fillPerfSel() {
  const sel = container.querySelector('#perfSel');
  sel.innerHTML = '';
  for (const p of PREFS) sel.append(new Option(t('perf.' + p), p));
  sel.value = readPref();
}

// Texture notice in the HUD: photo sets loading (they apply by themselves), finish sets missing on disk.
const note = { mode: null, timer: null, missing: new Map(), dismissed: new Set(), fetching: false };

function showNote(text, mode, buttons = []) {
  clearTimeout(note.timer);
  note.mode = mode;
  const box = container.querySelector('#tex3dNote');
  box.querySelector('#tex3dText').textContent = text;
  box.querySelector('#tex3dBtns').replaceChildren(...buttons.map(([act, key]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.act = act;
    b.textContent = t(key);
    return b;
  }));
  box.hidden = false;
}

function hideNote(after = 0) {
  clearTimeout(note.timer);
  const close = () => { note.mode = null; container.querySelector('#tex3dNote').hidden = true; };
  if (after) note.timer = setTimeout(close, after);
  else close();
}

const local = e => e.name?.[getLang()] || e.name?.ru || e.id;

function showMissing() {
  if (!note.missing.size || note.fetching || quality !== 'photo') return;
  const list = [...note.missing.values()];
  const mb = Math.round(list.reduce((s, e) => s + (e.mb || 5), 0));
  showNote(t('tex3d.missing', { names: list.map(local).join(getLang() === 'en' ? '”, “' : '», «'), mb }), 'missing',
    [['download', 'tex3d.download'], ['later', 'tex3d.later']]);
}

const autoFetch = () => canFetchLib() && photoAuto();

// The server takes one download at a time: the sets go one after another.
async function downloadMissing() {
  note.fetching = true;
  let failed = false;
  for (const e of [...note.missing.values()]) {
    const started = Date.now();
    const tick = () => showNote(t('tex3d.fetching', { name: local(e), s: Math.round((Date.now() - started) / 1000) }), 'fetch');
    tick();
    const timer = setInterval(tick, 500);
    try {
      await fetchLibSet(e.id);
      note.missing.delete(e.id);
    } catch {
      failed = true;
    } finally {
      clearInterval(timer);
    }
  }
  note.fetching = false;
  if (!failed && note.missing.size && autoFetch()) return downloadMissing();   // more sets asked for meanwhile
  if (failed && !note.failShown) {
    note.failShown = true;      // once a session: the simple textures stay, the scene works as it is
    showNote(t('tex.fetchFail'), 'error');
    hideNote(4000);
  } else if (failed) {
    hideNote();
  } else if (libPending()) {
    showNote(t('tex3d.libLoading'), 'lib');
    hideNote(30000);            // backstop: the note never stays for good
  } else {
    hideNote();
  }
}

// Simple (procedural) / Photo (CC0) textures; the whole scene is rebuilt with new materials.
// The first switch to Photo loads ~2 MB: the HUD says so and counts the files.
async function applyQuality(q, save = false) {
  const loading = q === 'photo' && !photoReady();
  const btn = container.querySelector('[data-quality="photo"]');
  if (loading) btn.classList.add('loading');
  const ok = await setQuality(q, loading
    ? (n, total) => showNote(t('tex3d.loading', { mb: PHOTO_MB, n, total }), 'photo') : null);
  btn.classList.remove('loading');
  if (loading) {
    if (ok) { showNote(t('tex3d.applied'), 'done'); hideNote(2500); } else hideNote();
  }
  if (q !== 'photo' && note.mode !== 'photo') hideNote();
  quality = q;
  container.querySelectorAll('[data-quality]').forEach(b => b.classList.toggle('active', b.dataset.quality === q));
  if (save) try { localStorage.setItem('fsp3d.tex', q); } catch { /* ignore */ }
  if (!ok) toast(t('v3d.photoFail'), true);
  forget();
  if (running) rebuild();
}

// Shells and furniture are rebuilt with new materials.
function forget() {
  for (const e of rooms3d.values()) e.key = e.fkey = '';
}

const T = 10;   // outer wall thickness, cm

// Walking, only what can be seen is drawn: the room the walker is in and the rooms behind open doors (two
// doorways deep); the others keep their lights (no shader rebuilds) but not their walls and furniture.
let portals = [];
const PORTAL_DEPTH = 2;
function cull() {
  let seen = null;
  if (controls.getMode() === 'walk' && rooms3d.size > 1) {
    seen = new Set([state.activeRoomId]);
    let edge = [state.activeRoomId];
    for (let d = 0; d < PORTAL_DEPTH && edge.length; d++) {
      const next = [];
      for (const l of portals) {
        const a = edge.includes(l.room) ? l.to : edge.includes(l.to) ? l.room : null;
        if (a && !seen.has(a) && anim.doorAjar(l.room, l.door)) { seen.add(a); next.push(a); }
      }
      edge = next;
    }
  }
  let changed = false;
  for (const [id, e] of rooms3d) {
    const v = !seen || seen.has(id);
    if (e.furniture && e.furniture.visible !== v) { e.furniture.visible = v; changed = true; }
    // A hidden room still shows its closed doors into a room in sight (leaf, frame, casing): the door belongs to
    // the room that owns it, and without it the doorway would show the empty background.
    const keep = v || !e.shell ? [] : portals.filter(l => l.room === id && seen.has(l.to))
      .flatMap(l => [e.shell.doors.find(d => d.userData.door.id === l.door)?.parent,
        e.shell.group.children.find(c => c.userData.revealDoor === l.door)]).filter(Boolean);
    if (e.shell && showShell(e.shell, v, keep)) changed = true;
  }
  if (changed) shadowsDirty = true;
}

// Shows a shell, or hides all of it but the `keep` objects (and the groups they sit in). True when it changed.
function showShell(shell, v, keep) {
  const key = v ? 'all' : keep.map(o => o.uuid).join(',') || 'none';
  if (shell.cullKey === key) return false;
  shell.cullKey = key;
  const g = shell.group;
  g.traverse(o => { if (o.userData.culled) { o.visible = true; delete o.userData.culled; } });
  const hide = o => { if (o.visible) { o.visible = false; o.userData.culled = true; } };
  if (v) return true;
  if (!keep.length) { hide(g); return true; }
  const path = new Set();
  for (const k of keep) for (let o = k; o && o !== g; o = o.parent) path.add(o);
  const walk = o => { for (const c of o.children) if (!path.has(c)) hide(c); else if (!keep.includes(c)) walk(c); };
  walk(g);
  return true;
}

// Rebuild only what changed: a room shell when its size, openings, structure, style or doorways change,
// its furniture when its items or their errors change. The overview is re-aimed when the outline changes.
function rebuild() {
  redrawShadows();
  const rooms = liveRooms();
  const links = doorLinks(rooms);
  portals = links.filter(l => l.to !== 'outside');
  for (const [id, e] of rooms3d) {
    if (rooms.some(r => r.id === id)) continue;
    disposeGroup(e.group);
    rooms3d.delete(id);
  }
  let changed = false;
  for (const r of rooms) {
    let e = rooms3d.get(r.id);
    if (!e) {
      e = { group: new THREE.Group(), key: '', fkey: '', lkey: '' };
      scene.add(e.group);
      rooms3d.set(r.id, e);
    }
    const { x, y } = posOf(r.pos);
    e.group.position.set(x / 100, 0, y / 100);
    e.doc = r;
    // Doorways of the neighbours' doors in this room's walls, the doorways it owns, half partitions.
    const holes = links.filter(l => l.to === r.id).map(l => ({ wall: l.wall, offset: l.offset, width: l.width, height: l.height }));
    const own = links.filter(l => l.room === r.id && l.to !== 'outside').map(l => {
      const o = r.openings.find(d => d.id === l.door), b = rooms.find(q => q.id === l.to);
      return { door: l.door, wall: o.wall, offset: o.offset, width: o.width, height: o.height,
        gap: Math.abs(wallLine(b, l.wall).at - wallLine(r, o.wall).at) };
    });
    const thick = {};
    for (const b of rooms) {
      if (b === r) continue;
      for (const a of adjacent(r, b, 2 * T)) thick[a.wallA] = Math.min(thick[a.wallA] ?? T / 100, a.gap / 200);
    }
    // A twin door (the neighbour's leaf is the real one) is only a hole in this wall.
    const twins = twinIds(rooms, r.id);
    const openings = (r.openings || []).filter(o => !twins.has(o.id));
    for (const o of (r.openings || []).filter(o => twins.has(o.id))) {
      const h = holes.find(q => q.wall === o.wall && q.offset < o.offset + o.width && o.offset < q.offset + q.width);
      if (!h) continue;
      const end = Math.max(h.offset + h.width, o.offset + o.width);
      h.offset = Math.min(h.offset, o.offset);
      h.width = end - h.offset;
      h.height = Math.max(h.height, o.height);
    }
    const key = JSON.stringify([r.room, openings, r.obstacles, r.style, holes, own, thick]);
    if (key !== e.key) {
      e.key = key;
      if (e.shell) disposeGroup(e.shell.group);
      e.shell = buildRoom(r.room, openings, r.style, { holes, thick });
      e.style = r.style;
      e.shell.group.add(buildObstacles(r.obstacles));
      for (const d of own) {
        const rv = revealParts(d.wall, d.offset, d.width, d.height, d.gap, r.room.L, r.room.W, r.style);
        rv.userData.revealDoor = d.door;
        e.shell.group.add(rv);
      }
      const shade = cornerShade(r.room.L / 100, r.room.W / 100, r.room.H / 100, [...openings, ...holes]);
      shade.visible = softOn;
      e.shell.group.add(shade);
      e.group.add(e.shell.group);
      changed = true;
    }
    if (buildFurniture(e, r)) changed = true;
  }
  const rs = rooms.map(roomRect);
  const bx = Math.min(...rs.map(q => q.x)), by = Math.min(...rs.map(q => q.y));
  const bounds = {
    x: bx / 100, z: by / 100, w: (Math.max(...rs.map(q => q.x + q.w)) - bx) / 100, d: (Math.max(...rs.map(q => q.y + q.h)) - by) / 100,
    H: Math.max(...rooms.map(r => r.room.H)) / 100
  };
  const ok = JSON.stringify(bounds);
  const resetView = ok !== outline;
  outline = ok;
  const entries = [...rooms3d].map(([id, e]) => ({ id, doc: e.doc, shell: e.shell, furniture: e.furniture, x: e.group.position.x, z: e.group.position.z }));
  if (changed) anim.attach(entries);
  controls.setApartment({
    rooms: entries, bounds,
    doorOpen: anim.doorOpen, openDoor: anim.openDoor, useDoor: anim.useDoor,
    onEnter: id => switchRoom(id)
  }, resetView);
  buildAllLights();
  syncLightHud();
  syncRoomHud(rooms);
  syncSelection();
}

// The selected items get a thin gold frame in the scene (one shared box, scaled per item), the primary one also a
// ring on the floor: it can be dragged (drag3d.js).
const SEL_BOX = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0));
const SEL_MAT = new THREE.LineBasicMaterial({ color: 0xc9a96e, transparent: true, opacity: 0.95, depthTest: false });
const SEL_RING = new THREE.RingGeometry(0.985, 1, 72).rotateX(-Math.PI / 2);
const RING_MAT = new THREE.MeshBasicMaterial({ color: 0xc9a96e, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide });
let selFrames = null, selRing = null;
// Frame of a selected ceiling light, cm: width and drop under the ceiling.
const FX_BOX = { chandelier: { w: 80, h: 62 }, pendant: { w: 40, h: 82 }, spot: { w: 16, h: 4 }, panel: { w: 60, h: 4 } };
function syncSelection() {
  if (!selFrames) { selFrames = new THREE.Group(); selFrames.name = 'selection'; scene.add(selFrames); }
  const e = rooms3d.get(state.activeRoomId) || (rooms3d.size === 1 ? [...rooms3d.values()][0] : null);
  const items = e ? (e.doc.items || []).filter(it => isSelected(it.id)) : [];
  // Boxes in cm of the room: { x, y (centre), w, d, h, elev }; a selected ceiling light gets one too.
  const boxes = items.map(it => { const r = rectOf(it); return { x: r.x + r.w / 2, y: r.y + r.h / 2, w: r.w, d: r.h, h: it.h, elev: it.elev || 0 }; });
  const fx = e && state.selectedFixture !== null ? fixturesOf(e.doc, state.lighting).find(f => f.id === state.selectedFixture) : null;
  if (fx) {
    const H = e.doc.room.H, s = FX_BOX[fx.kind] || FX_BOX.spot;
    const w = fx.kind === 'panel' ? Math.min(120, e.doc.room.L * 0.4) + 6 : s.w, d = fx.kind === 'panel' ? Math.min(60, e.doc.room.W * 0.3) + 6 : s.w;
    boxes.push({ x: fx.x, y: fx.y, w, d, h: s.h, elev: H - s.h });
  }
  while (selFrames.children.length > boxes.length) selFrames.remove(selFrames.children.at(-1));
  while (selFrames.children.length < boxes.length) {
    const l = new THREE.LineSegments(SEL_BOX, SEL_MAT);
    l.renderOrder = 10;
    selFrames.add(l);
  }
  boxes.forEach((b, i) => {
    const l = selFrames.children[i], pad = 0.015;
    l.scale.set(b.w / 100 + 2 * pad, b.h / 100 + pad, b.d / 100 + 2 * pad);
    l.position.set(e.group.position.x + b.x / 100, b.elev / 100, e.group.position.z + b.y / 100);
  });
  if (!selRing) { selRing = new THREE.Mesh(SEL_RING, RING_MAT); selRing.renderOrder = 9; selFrames.parent.add(selRing); }
  const main = items.find(it => it.id === state.selectedId);
  selRing.visible = !!main;
  if (main) {
    const r = rectOf(main), k = Math.hypot(r.w, r.h) / 200 + 0.08;
    selRing.scale.set(k, 1, k);
    selRing.position.set(e.group.position.x + (r.x + r.w / 2) / 100, 0.006, e.group.position.z + (r.y + r.h / 2) / 100);
  }
  requestRender();
}

// Lights: every room gets its full fixture; the active room (where the walker is) also sky light, sun and
// full-size shadows. When the rooms together need more lamps than the device tier allows (SETTINGS.maxLamps),
// the spots of the other rooms become one down-light each. Rebuilt only for a new shell, fixture type or main
// room; scene and lamp changes are tweened.
function buildAllLights() {
  const prev = mainLights?.userData.cur;
  const fx = new Map([...rooms3d].map(([id, e]) => [id, fixturesOf(e.doc, state.lighting)]));
  let total = 0;
  for (const [id, e] of rooms3d) total += lampCount(fx.get(id), e.shell.size);
  const merged = total > SETTINGS[tier].maxLamps;
  for (const [id, e] of rooms3d) {
    const main = id === state.activeRoomId || rooms3d.size === 1;
    const look = styleOf(e.style).furniture;
    const base = [main, merged && !main, tier, e.key, look].join('|');
    const lk = base + JSON.stringify(fx.get(id));
    if (lk !== e.lkey) {
      // Only the fixtures moved or changed: the lamps keep their level (no fade-in flash).
      const fade = base !== e.lbase;
      e.lkey = lk;
      e.lbase = base;
      if (e.lights) disposeGroup(e.lights);
      e.lights = buildLights(e.shell.size, e.shell.windows[0] || null, state.lighting, prev, main, merged && !main, look,
        { fixtures: fx.get(id), fade });
      e.group.add(e.lights);
    } else {
      setLightTargets(e.lights, state.lighting);
    }
    if (main) mainLights = e.lights;
  }
  scene.environmentIntensity = mainLights.userData.cur.env;
  for (const e of rooms3d.values()) if (e.furniture) applyFixtures(e.furniture, mainLights.userData.cur.fix);
}

// Furniture of one room: red tint for items with errors, green for a freshly auto-placed one. True when rebuilt.
function buildFurniture(e, r) {
  const errors = validateAll(roomView(r.id));
  const now = performance.now();
  const found = r.id === state.activeRoomId && state.found && now < state.found.until ? state.found : null;
  const status = it => (errors.get(it.id) || []).length ? 'bad' : found && found.id === it.id ? 'found' : 'ok';
  const fkey = JSON.stringify([r.items, r.items.map(status), r.style, state.materials]);
  if (found) {
    clearTimeout(foundTimer);
    foundTimer = setTimeout(() => { if (running) rebuild(); }, found.until - now + 20);
  }
  if (fkey === e.fkey) return false;
  // A forced rebuild (new materials, quality) builds every model anew; otherwise a model whose look did not
  // change is kept and only put in its new place, so dragging an item does not rebuild the room.
  if (!e.fkey || !e.furniture) {
    if (e.furniture) disposeGroup(e.furniture);
    e.furniture = new THREE.Group();
    e.furniture.name = 'furniture';
    e.group.add(e.furniture);
    e.models = new Map();
  }
  e.fkey = fkey;
  const keep = new Map();
  for (const it of r.items) {
    const look = JSON.stringify([{ ...it, x: 0, y: 0, rot: 0 }, status(it), r.style, state.materials]);
    let m = e.models.get(it.id);
    if (m && m.look === look) {
      placeItem(m.obj, it);
      e.models.delete(it.id);
    } else {
      m = { look, obj: buildItem(it, status(it), state.materials, r.style, state.catalog) };
      e.furniture.add(m.obj);
    }
    keep.set(it.id, m);
  }
  for (const m of e.models.values()) disposeGroup(m.obj);
  e.models = keep;
  e.contact?.geometry?.dispose();
  e.contact?.removeFromParent();
  e.contact = contactShadows(footprints(e.furniture));
  if (e.contact) {
    e.contact.visible = softOn;
    e.furniture.add(e.contact);
  }
  return true;
}

// Name of the active room (the one the walker is in) when the apartment has several.
function syncRoomHud(rooms) {
  const el = container.querySelector('#room3d');
  const r = rooms.find(q => q.id === state.activeRoomId);
  el.hidden = rooms.length < 2 || !r;
  if (r) el.textContent = '\u{1F4CD} ' + r.name;
}

function fillCeilSel() {
  const sel = container.querySelector('#ceilSel');
  sel.replaceChildren(...CEILINGS.map(c => new Option(t('light.' + c), c)));
  syncLightHud();
}

const SCENES = ['day', 'evening', 'night'];

function nextScene() {
  const cur = lightingOf(state.lighting).scene;
  state.lighting = { ...lightingOf(state.lighting), scene: SCENES[(SCENES.indexOf(cur) + 1) % SCENES.length], lampsOn: null };
  emit();
}

// Button titles name their hotkeys.
function lightTitles() {
  container.querySelectorAll('[data-light]').forEach(b => { b.title = `${t('light.' + b.dataset.light)} (N)`; });
}

function toggleLamps() {
  state.lighting = { ...lightingOf(state.lighting), lampsOn: !lampsOn(state.lighting) };
  emit();
}

function syncLightHud() {
  const l = lightingOf(state.lighting);
  container.querySelectorAll('[data-light]').forEach(b => b.classList.toggle('active', b.dataset.light === l.scene));
  container.querySelector('#lampBtn').classList.toggle('active', lampsOn(l));
  container.querySelector('#ceilSel').value = l.ceiling;
}

// Soft shadows: contact patches under furniture and corner shade (softShadows.js), in every mode and tier.
function syncSoft() {
  container.querySelector('#aoBtn').classList.toggle('active', softOn);
}

function setSoft(on) {
  softOn = on;
  try { localStorage.setItem('fsp3d.ao', on ? '1' : '0'); } catch { /* ignore */ }
  for (const e of rooms3d.values()) e.group.traverse(o => { if (o.userData.softShadow) o.visible = on; });
  syncSoft();
  dirty = true;
}

// A failed frame must not freeze the view silently: the error is logged and shown once, the loop goes on.
let drawFailed = false;
function draw() {
  try {
    updateSpotClip(scene);
    if (composer) composer.render();
    else renderer.render(scene, camera);
  } catch (err) {
    if (drawFailed) return;
    drawFailed = true;
    console.error('3D render failed', err);
    toast(t('v3d.drawFail'), true);
  }
}

// The loop keeps ticking (walking and orbit damping need it) but draws only when something changed;
// a still scene costs no GPU time. Hidden tab or view off screen: nothing at all.
function loop() {
  if (!running) return;
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.25);
  if (!visible || !onScreen || compiling) { prevDrawn = false; return; }
  if (controls.update(dt)) shadowsDirty = true;
  if (anim.update(dt)) shadowsDirty = true;
  cull();
  let tweened = false;
  for (const e of rooms3d.values()) if (e.lights && tweenLights(e.lights, dt)) tweened = true;
  if (tweened && mainLights) {
    scene.environmentIntensity = mainLights.userData.cur.env;
    for (const e of rooms3d.values()) if (e.furniture) applyFixtures(e.furniture, mainLights.userData.cur.fix);
    shadowsDirty = true;
  }
  camera.updateMatrixWorld();
  const moved = !lastView.equals(camera.matrixWorld) || !lastProj.equals(camera.projectionMatrix);
  if (!(dirty || moved || shadowsDirty)) { prevDrawn = false; return; }
  lastView.copy(camera.matrixWorld);
  lastProj.copy(camera.projectionMatrix);
  if (shadowsDirty) renderer.shadowMap.needsUpdate = true;
  dirty = shadowsDirty = false;
  draw();
  for (const r of drawnWaiters.splice(0)) r();
  // Frame rate counts only frames drawn one after another (idle time is not slowness).
  if (prevDrawn) gov?.frame(dt);
  prevDrawn = true;
}

export function show(el) {
  if (!renderer && !init(el)) return;
  const was = running;
  running = true;
  resize();
  rebuild();
  redrawShadows();
  controls.updateHint();
  if (was) return;   // one loop only
  // The shaders of the first frame are compiled off the main thread where the GPU allows it
  // (KHR_parallel_shader_compile), so opening the 3D does not freeze the page.
  compiling = true;
  renderer.compileAsync(scene, camera).catch(() => {}).finally(() => { compiling = false; dirty = true; });
  clock.start();
  loop();
}

export function hide() {
  running = false;
  if (renderer) controls.release();
}

// One frame at 2× pixel ratio copied right after rendering (no preserveDrawingBuffer needed).
export function snapshotCanvas() {
  const pr = renderer.getPixelRatio();
  renderer.setPixelRatio(2);
  resize();
  renderer.shadowMap.needsUpdate = true;
  draw();
  const c = document.createElement('canvas');
  c.width = renderer.domElement.width;
  c.height = renderer.domElement.height;
  c.getContext('2d').drawImage(renderer.domElement, 0, 0);
  renderer.setPixelRatio(pr);
  resize();
  renderer.shadowMap.needsUpdate = true;
  draw();
  return c;
}

// Static surroundings, not rebuilt with the rooms and without shadows (null removes them).
export function setContext(group) {
  if (context) disposeGroup(context);
  context = group;
  if (group) scene.add(group);
  redrawShadows();
}

export const getScene = () => scene;
export const getCamera = () => camera;
export const getRenderer = () => renderer;
