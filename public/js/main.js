import { pane } from './pane.js';
import { t, initLangSwitcher, onLangChange } from './i18n.js';
import { initTheme, onThemeChange } from './theme.js';
import { initIcons } from './icons.js';
import { state, onChange, emit, itemName, docFromState, applyDoc } from './state.js';
import { history } from './history.js';
import { findSpot } from './autoplace.js';
import { parseCatalog } from './catalog.js';
import { initProjects, persist, renderHeader, openHandoff } from './projects.js';
import { initProjectsDialog } from './projectsDialog.js';
import { initFurnish } from './furnishUi.js';
import { initOrder } from './order.js';
import { initCompare } from './compare.js';
import { initTextures } from './textures.js';
import { initSnapshot } from './snapshot.js';
import { initRenderer, requestDraw, drawNow, setErrors as setDrawErrors, setObWarnings as setDrawObWarnings, setPassages as setDrawPassages,
  setRoomErrors, liveRooms } from './renderer.js';
import { roomView as aptRoomView, overlapsRooms } from './apartment.js';
import { overlapText } from './interaction.js';
import { validateAll, validateWarnings, obstacleWarnings } from './validate.js';
import { narrowPassages } from './passages.js';
import { clampOpening } from './openings.js';
import { fitObstacleHeight } from './obstacles.js';
import { initInteraction } from './interaction.js';
import { initV3dBar } from './v3dBar.js';
import { initUI, fillCatalog, syncForms, refresh, toast, describe, setErrors as setUiErrors, setWarnings, setObWarnings, setPassages,
  setRoomNotes } from './ui.js';

let lastH = null;   // full-height obstacles follow the ceiling

function update() {
  for (const o of state.openings) clampOpening(o, state.room);
  for (const o of state.obstacles) fitObstacleHeight(o, lastH ?? state.room.H, state.room);
  lastH = state.room.H;
  setWarnings(validateWarnings(state));
  const obWarn = obstacleWarnings(state);
  setObWarnings(obWarn);
  setDrawObWarnings(obWarn);
  const pass = narrowPassages(state);
  setPassages(pass);
  setDrawPassages(pass);
  const errors = validateAll(state);
  setDrawErrors(errors);
  setUiErrors(errors);
  setRoomErrors(otherRoomErrors());
  setRoomNotes(overlapsRooms(liveRooms()).map(overlapText));
  requestDraw();
  refresh();
  renderHeader();
  persist();
  closeStaleField();
  history.record(snapshot());
  syncUndo();
}

// Errors of the other rooms (red items on the apartment plan); recomputed only when a room changes.
const roomCache = new Map();   // roomId → { key, errors }
function otherRoomErrors() {
  const out = new Map(), settings = JSON.stringify(state.settings);
  for (const r of state.rooms) {
    if (r.id === state.activeRoomId) continue;
    const key = settings + JSON.stringify([r.room, r.items, r.openings, r.obstacles]);
    let c = roomCache.get(r.id);
    if (c?.key !== key) roomCache.set(r.id, c = { key, errors: validateAll(aptRoomView(state, r.id)) });
    out.set(r.id, c.errors);
  }
  return out;
}

// ---- undo / redo ----
// View toggles live in settings (saved with the room) but are not undo steps.
const VIEW_KEYS = ['showZones', 'showPassages'];
const snapshot = () => {
  const d = docFromState();
  for (const k of VIEW_KEYS) delete d.settings[k];
  return JSON.stringify(d);
};

function step(dir) {
  closeStaleField();
  const snap = dir < 0 ? history.undo() : history.redo();
  if (!snap) return;
  const view = Object.fromEntries(VIEW_KEYS.filter(k => k in state.settings).map(k => [k, state.settings[k]]));
  applyDoc(JSON.parse(snap));
  Object.assign(state.settings, view);
  syncForms();
  emit();
  toast(t(dir < 0 ? 'hist.undone' : 'hist.redone'));
}

function syncUndo() {
  document.getElementById('undoBtn').disabled = !history.canUndo();
  document.getElementById('redoBtn').disabled = !history.canRedo();
}

// Editing one field (all its keystrokes) is a single step: focus opens it, blur closes it.
let field = null;
function closeStaleField() {
  if (field && document.activeElement !== field) { field = null; history.end(); }
}

function initHistory() {
  history.setSource(snapshot);
  document.getElementById('undoBtn').addEventListener('click', () => step(-1));
  document.getElementById('redoBtn').addEventListener('click', () => step(1));
  window.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (e.target instanceof Element && e.target.closest('input, textarea, select')) return;
    if (e.code === 'KeyZ') step(e.shiftKey ? 1 : -1);
    else if (e.code === 'KeyY') step(1);
    else return;
    e.preventDefault();
  });
  const sidebar = document.querySelector('.sidebar') || document.body;
  const open = e => {
    if (!e.target.matches('input, select') || field === e.target) return;
    if (field) history.end();
    field = e.target;
    history.begin();
  };
  sidebar.addEventListener('focusin', open);
  sidebar.addEventListener('input', open, true);   // capture: before the form handler changes state
  sidebar.addEventListener('focusout', e => {
    if (e.target !== field) return;
    field = null;
    history.end();
  });
}

// Move the item to the first free spot and flash it green, or explain why not.
function autoPlace(item) {
  const res = findSpot(item, state);
  if (res.ok) {
    Object.assign(item, { x: res.x, y: res.y, rot: res.rot });
    state.found = { id: item.id, until: performance.now() + 2000 };
    state.selectedId = item.id;
    emit();
    toast(t(res.soft ? 'auto.foundSoft' : 'auto.found', { name: itemName(item) }), res.soft);
  } else {
    emit();
    toast(describe(res), true);
  }
}

// 2D plan ⇄ 3D scene ⇄ both (plan above, scene below); the 3D module is loaded on first use.
let view3d = null;
async function setView(mode) {
  const is3d = mode === '3d', split = mode === 'split';
  pane.mode = mode;
  pane.last = is3d ? '3d' : 'plan';
  document.getElementById('view2dBtn').classList.toggle('active', mode === '2d');
  document.getElementById('view3dBtn').classList.toggle('active', is3d);
  document.getElementById('viewSplitBtn').classList.toggle('active', split);
  document.getElementById('view3d').hidden = !is3d && !split;
  document.getElementById('splitHandle').hidden = !split;
  document.querySelector('.stage').classList.toggle('is3d', is3d);
  document.querySelector('.stage').classList.toggle('isSplit', split);
  splitSide();
  requestDraw();
  // On a phone the scene is about a screen tall: bring it up under the 2D / 3D switch (lying: the scene alone).
  if (is3d && !embed && matchMedia('(max-width: 860px)').matches) {
    const lying = matchMedia('(orientation: landscape)').matches;
    requestAnimationFrame(() => document.querySelector(lying ? '#canvasWrap' : '.stage-bar').scrollIntoView({ block: lying ? 'end' : 'start' }));
  }
  if (is3d || split) {
    window.preload3d?.();   // all the 3D modules in one wave (index.html, scripts/preload.js)
    view3d ??= await import('./3d/scene3d.js');
    view3d.show(document.getElementById('view3d'));
  } else if (view3d) {
    view3d.hide();
    requestDraw();
  }
}

function initViewSwitch() {
  const wrap = document.getElementById('stageBody');
  document.getElementById('view2dBtn').addEventListener('click', () => setView('2d'));
  document.getElementById('view3dBtn').addEventListener('click', () => setView('3d'));
  document.getElementById('viewSplitBtn').addEventListener('click', () => setView('split'));
  initSplit();
  const toggleFs = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else wrap.requestFullscreen?.().catch(() => {});
  };
  document.getElementById('fullscreenBtn').addEventListener('click', toggleFs);
  document.getElementById('fs3dBtn').addEventListener('click', toggleFs);
  document.getElementById('exitFsBtn').addEventListener('click', () => document.exitFullscreen());
  document.addEventListener('fullscreenchange', () => {
    document.getElementById('exitFsBtn').hidden = !document.fullscreenElement;
  });
}

// "Plan + 3D" on a wide screen: the plan tools stand in a column at the right of the plan, the scene tools at the
// right of the scene and the view switch on top of the plan column, so both views get the full height (2D and 3D alone
// keep their bars). The nodes are moved, their listeners stay.
const wideSplit = matchMedia('(min-width: 861px)');
let barHome = null;
function splitSide() {
  const stage = document.querySelector('.stage'), bar = stage.querySelector('.stage-bar');
  barHome ??= { seg: bar.querySelector('.seg'), tools: bar.querySelector('.btn-group') };
  const on = stage.classList.contains('isSplit') && wideSplit.matches && !embed;
  if (stage.classList.contains('splitSide') === on) return;
  stage.classList.toggle('splitSide', on);
  const { seg, tools } = barHome;
  seg.classList.toggle('view-seg', on);
  tools.classList.toggle('side-tools', on);
  if (on) {
    tools.prepend(seg);
    document.getElementById('canvasWrap').append(tools);
  } else {
    bar.prepend(seg);
    bar.append(tools);
  }
}
wideSplit.addEventListener('change', () => { splitSide(); requestDraw(); });

// Split divider: drag to share the height between the plan and the scene (kept per browser).
function initSplit() {
  const wrap = document.getElementById('canvasWrap'), handle = document.getElementById('splitHandle');
  const set = f => wrap.style.setProperty('--split', `${Math.round(Math.min(78, Math.max(22, f)) * 10) / 10}%`);
  try { set(Number(localStorage.getItem('fsp3d.split')) || 42); } catch { set(42); }
  let dragging = false;
  handle.addEventListener('pointerdown', e => { dragging = true; handle.setPointerCapture(e.pointerId); handle.classList.add('drag'); });
  handle.addEventListener('pointermove', e => {
    if (!dragging) return;
    const r = wrap.getBoundingClientRect();
    set((e.clientY - r.top) / r.height * 100);
    requestDraw();
  });
  handle.addEventListener('pointerup', () => {
    dragging = false;
    handle.classList.remove('drag');
    try { localStorage.setItem('fsp3d.split', parseFloat(wrap.style.getPropertyValue('--split'))); } catch { /* storage unavailable */ }
  });
  // Keys follow the half pressed last.
  document.getElementById('plan').addEventListener('pointerdown', () => { pane.last = 'plan'; }, true);
  document.getElementById('view3d').addEventListener('pointerdown', () => { pane.last = '3d'; }, true);
  // A phone turned sideways has no room for both: the scene alone.
  matchMedia('(max-width: 860px) and (orientation: landscape)').addEventListener('change', e => { if (e.matches && pane.mode === 'split') setView('3d'); });
}

async function loadCatalog() {
  try {
    const res = await fetch('/api/catalog');
    if (!res.ok) throw new Error(res.status);
    const c = parseCatalog(await res.json());
    state.catalog = c.items;
    state.materials = c.materials;
    state.pricing = c.pricing;
  } catch {
    toast(t('catalog.fail'), true);
  }
}

// The floor view embedded in the showcase card: only the 3D scene, the apartment is not saved.
const embed = ['floor', 'building'].includes(new URLSearchParams(location.search).get('embed'));
// The 3D code and the building are fetched at once, side by side with the planner's own start (not after it).
const early = embed ? {
  floor: import('./floor3d.js').then(f => { f.prefetchBuilding(f.embedParams()); return f; }),
  scene: import('./3d/scene3d.js'), controls: import('./3d/controls3d.js'), anim: import('./3d/anim3d.js')
} : null;
for (const p of Object.values(early || {})) p.catch(() => {});

async function startEmbed() {
  try {
    const floor = await early.floor;
    // The overview shows only the apartment: set before its first build.
    (await early.scene).setOverviewSkip([floor.CORR_ID, floor.LOBBY_ID, floor.PASSAGE_ID]);
    const params = floor.embedParams();
    if (!params) throw new Error('bad params');
    const ctx = await floor.openFloor(params);
    await setView('3d');
    view3d.setContext(floor.floorContext(ctx));
    const controls = await early.controls;
    floor.enableCorridor(ctx, { setContext: view3d.setContext, setDoorHook: (await early.anim).setDoorHook, release: controls.release, resume: controls.walkNow });
    controls.setMode('walk');
    controls.walkNow();
    const card = document.querySelector('#walkOverlay [data-i18n]');
    card.dataset.i18n = 'v3d.clickToContinue';
    card.textContent = t('v3d.clickToContinue');
    // The showcase hides its "loading" cover once the first frame is on screen (or after a backstop).
    await Promise.race([view3d.nextFrame(), new Promise(r => setTimeout(r, 8000))]);
  } catch {
    toast(t('bld.loadFail'), true);
  }
  if (parent !== window) parent.postMessage({ type: 'fsp3d:ready' }, location.origin);
}

async function start() {
  if (embed) document.body.classList.add('embed');
  initLangSwitcher();
  initTheme();
  initIcons();
  onThemeChange(() => drawNow());   // synchronously: the theme switch takes its snapshot right after
  document.fonts?.ready.then(() => requestDraw());
  initRenderer(document.getElementById('plan'), document.getElementById('canvasWrap'));
  initInteraction(document.getElementById('plan'));
  initUI({ autoPlace });
  initOrder();
  initCompare();
  initViewSwitch();
  initV3dBar();
  initTextures();
  initHistory();
  initSnapshot();
  await loadCatalog();
  initProjects();
  if (!embed) openHandoff();
  initProjectsDialog();
  initFurnish();
  fillCatalog();
  syncForms();
  onChange(update);
  onLangChange(() => { fillCatalog(); update(); });
  update();
  if (embed) startEmbed();
}

start();
// The 3D code comes in the background once the planner is up: «3D» then opens without waiting for it.
if (!embed) (window.requestIdleCallback || (f => setTimeout(f, 2000)))(() => window.preload3d?.(), { timeout: 4000 });
// The consultant of the site (11 §5): loaded in the background, the planner does not wait for it. An apartment from the chat opens in the showcase.
if (!embed) (window.requestIdleCallback || (f => setTimeout(f, 2500)))(() => import('./chat/widget.js').then(m => m.mountChat({
  page: 'planner',
  onOpen: (no, { book }) => { location.href = `/building.html#apt=${no}${book ? '&book=1' : ''}`; }
})), { timeout: 5000 });
