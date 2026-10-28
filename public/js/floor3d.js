// Floor view embedded in the showcase (building.html → iframe /index.html?embed=floor&b=<id>&apt=<no>, or
// /index.html?embed=building&b=<id>&floor=<n> for a floor without an apartment, floor 1 = the lobby): the chosen apartment,
// the floor corridor (or the lobby) are a temporary project (full detail, never saved), the other apartments
// a low-detail shell around them. From the corridor the doors of the neighbours lead in: free and booked ones
// open (the detailed apartment is swapped behind a short fade), sold ones stay locked. The lift goes to any
// floor, the stairs one floor up or down.
// Coordinates: the section's (cm), the scene origin is the section corner.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { t, getLang } from './i18n.js';
import { state, onChange } from './state.js';
import { normalizeProject } from './storage.js';
import { doorLinks, entrances, roomRect } from './apartment.js';
import { localRoomName } from './building.js';
import { styleOf } from './style.js';
import { openTemporary } from './projects.js';
import { toast } from './ui.js';

export const CORR_ID = 'corr';
export const LOBBY_ID = 'lobby';
export const PASSAGE_ID = 'lobby2';
const OPPOSITE = { north: 'south', south: 'north', west: 'east', east: 'west' };
const PART = 10;     // partition between the lobby and the entrance passage, cm

export function embedParams(search = location.search) {
  const q = new URLSearchParams(search);
  const b = q.get('b') || '', mode = q.get('embed');
  if (!/^[a-z0-9-]{1,60}$/.test(b)) return null;
  const apt = Number(q.get('apt')), floor = Number(q.get('floor'));
  if (mode === 'floor' && Number.isInteger(apt) && apt > 0) return { b, apt };
  if (mode === 'building') return { b, floor: Number.isInteger(floor) && floor > 0 ? floor : 1, street: q.get('from') === 'street' };
  return null;
}

// Rooms of an apartment on the floor (section coordinates).
const placed = a => a.plan.map(r => ({ ...structuredClone(r), pos: { x: a.at.x + r.pos.x, y: a.at.y + r.pos.y } }));

// The entrance door of an apartment as seen from the corridor: { wall (of the corridor), x (cm along it), width }.
export function entranceDoor(a) {
  const rooms = placed(a);
  const link = doorLinks(rooms).find(l => l.to === 'outside');
  if (!link) return null;
  const r = rooms.find(q => q.id === link.room), o = r.openings.find(d => d.id === link.door);
  if (o.wall !== 'north' && o.wall !== 'south') return null;
  return { wall: OPPOSITE[o.wall], x: r.pos.x + o.offset, width: o.width, height: o.height || 210 };
}

const hallStyle = color => ({ ...styleOf({}), floor: 'tile', wall: { material: 'paint', color }, accentWall: null, finish: 'finished' });

// Lift and stair doors in the wall `wall` of a room at `x0` (section x of the room's left edge); lifts come
// first, so the walker arriving on a floor stands at the lift.
function coreDoors(core, wall, x0, add) {
  add(wall, core.x + 60 - x0, 110, 210, { lift: 1 });
  add(wall, core.x + 200 - x0, 110, 210, { lift: 2 });
  add(wall, core.x + core.w - 150 - x0, 90, 210, { stairs: true });
}

function doorAdder(openings, doors, roomId) {
  let id = 1;
  return (wall, offset, width, height, meta) => {
    openings.push({ id, kind: 'door', wall, offset: Math.round(offset), width, height, hinge: 'start' });
    if (meta) doors.set(`${roomId}:${id}`, meta);
    id++;
  };
}

/**
 * The floor corridor as a room of the project: the lift and stair doors in the wall facing the core, the doors
 * of the other apartments (they lead "outside", i.e. to the shells).
 * → { rooms: [room], doors: Map('roomId:doorId' → { aptNo } | { lift } | { stairs }) }
 */
export function corridorRooms(bld, floor, aptNo) {
  const c = bld.corridor;
  if (!c) return null;
  const H = bld.section?.H || 280;
  const f = bld.floorsData.find(q => q.n === floor);
  const openings = [], doors = new Map();
  const add = doorAdder(openings, doors, CORR_ID);
  if (bld.core) coreDoors(bld.core, bld.core.y >= c.y + c.h ? 'south' : 'north', c.x, add);
  for (const o of f?.apartments || []) {
    if (o.no === aptNo) continue;
    const e = entranceDoor(o);
    if (e) add(e.wall, e.x - c.x, e.width, e.height, { aptNo: o.no });
  }
  const room = {
    id: CORR_ID, name: t('floor3d.corridor', { n: floor }), purpose: 'hall',
    pos: { x: c.x, y: c.y }, room: { L: c.w, W: c.h, H, plinth: 2 },
    openings, items: [], obstacles: [], style: hallStyle('#e6e1d8')
  };
  return { rooms: [room], doors };
}

/**
 * Ground floor: the lobby north of the core (glazed to the street, lifts and stairs in its south wall, locked
 * doors to the commercial units) and the entrance passage east of the core with the street doors.
 * → { rooms, doors, entrance: { x0, x1 } (section x of the street doors) }
 */
export function lobbyRooms(bld) {
  const g = bld.floorsData.find(f => f.n === 1);
  const lb = g?.lobby, core = bld.core;
  if (!lb || !core) return null;
  const H = bld.section?.H || 280;
  const doors = new Map();
  // Lobby: from the north facade to the core.
  const L = lb.w, W = core.y - lb.y;
  const ops = [];
  const add = doorAdder(ops, doors, LOBBY_ID);
  coreDoors(core, 'south', lb.x, add);
  const px = core.x + core.w + PART, pw = lb.x + lb.w - px;      // the passage: x and width
  add('south', px - lb.x + 40, pw - 80, 220, null);              // into the passage (an ordinary door)
  add('west', W / 2 - 50, 100, 210, { rent: true });
  add('east', W / 2 - 50, 100, 210, { rent: true });
  // Shop-front glass to the north, like the facade (3 m pitch).
  for (let x = 20; x + 260 <= L; x += 300) ops.push({ id: ops.length + 1, kind: 'window', wall: 'north', offset: x, width: 260, height: 250, sill: 0 });
  const it = (id, type, x, y, w, d, h, rot, color) => ({ id, type, x, y, w, d, h, rot, color });
  const lobby = {
    id: LOBBY_ID, name: t('floor3d.lobby'), purpose: 'hall',
    pos: { x: lb.x, y: lb.y }, room: { L, W, H, plinth: 2 }, openings: ops, obstacles: [],
    items: [
      it(1, 'desk', 80, 330, 180, 70, 105, 0, '#5d4037'),            // concierge
      it(2, 'chair', 145, 260, 45, 45, 90, 0, '#37474f'),
      it(3, 'bookshelf', 2, 720, 200, 35, 170, 270, '#9aa3ab'),    // mailboxes, clear of the rent door
      it(4, 'sofa', 430, 20, 230, 95, 85, 0, '#6d7b8a'),
      it(5, 'coffeetable', 495, 170, 100, 60, 45, 0, '#3e2723'),
      it(6, 'armchair', 330, 150, 85, 85, 85, 90, '#8d6e63'),
      it(7, 'plant', 2, 2, 60, 60, 140, 0, '#2e7d32'),
      it(8, 'plant', L - 62, 2, 60, 60, 140, 0, '#2e7d32'),
      it(9, 'floorlamp', 670, 30, 40, 40, 160, 0, '#cfd8dc'),
      // Paintings (art3d.js): Registan over the waiting area by the lifts, textiles on the side walls.
      { ...it(10, 'painting', 40, W - 6, 260, 4, 130, 180, '#3b2a1e'), elev: 110, art: 'registan' },
      { ...it(11, 'painting', 2, 170, 90, 4, 150, 270, '#3b2a1e'), elev: 80, art: 'adras' },
      { ...it(12, 'painting', L - 6, 170, 120, 4, 120, 90, '#3b2a1e'), elev: 100, art: 'suzani' },
      { ...it(13, 'painting', L - 6, 660, 90, 4, 150, 90, '#3b2a1e'), elev: 80, art: 'atlas' }
    ],
    seq: 14, style: hallStyle('#ece6db')
  };
  // Passage: beside the core, from the lobby to the street doors.
  const dw = 220, entrance = { x0: Math.round(px + (pw - dw) / 2), x1: Math.round(px + (pw + dw) / 2) };
  const pops = [{ id: 1, kind: 'door', wall: 'south', offset: entrance.x0 - px, width: dw, height: 240, hinge: 'start' }];
  doors.set(`${PASSAGE_ID}:1`, { street: true });
  const passage = {
    id: PASSAGE_ID, name: t('floor3d.entrance'), purpose: 'hall',
    pos: { x: px, y: core.y + PART }, room: { L: pw, W: lb.y + lb.h - core.y - PART, H, plinth: 2 },
    openings: pops, items: [], obstacles: [], style: hallStyle('#ece6db')
  };
  return { rooms: [lobby, passage], doors, entrance };
}

/**
 * The project of a floor: the apartment `a` (names "Apt. №N · room", the walker in its hall) plus the corridor,
 * or only the corridor (the walker at the lift), or on floor 1 the lobby.
 */
function floorProject(bld, floor, a, keep = null, fromStreet = false) {
  const lang = getLang();
  let rooms = [], start = null;
  if (a) {
    rooms = placed(a).map(r => ({ ...r, name: t('floor3d.room', { no: a.no, name: localRoomName(r.name, lang) }) }));
    start = entrances(rooms)[0] || rooms[0].id;
  }
  const extra = floor === 1 ? lobbyRooms(bld) : corridorRooms(bld, floor, a?.no);
  if (extra) {
    rooms.push(...extra.rooms);
    start ||= (fromStreet && extra.rooms.find(r => r.id === PASSAGE_ID)?.id) || extra.rooms[0].id;
  }
  if (!rooms.length) throw new Error('empty floor');
  if (keep?.finish) for (const r of rooms) r.style = { ...styleOf(r.style), finish: keep.finish };
  const title = bld.name?.[lang] || bld.name?.ru || bld.id;
  const name = a ? `${title}, №${a.no}` : `${title}, ${t('bld.floor', { n: floor })}`;
  // Not importProject: its size check (≤ 30 m) is for files, the corridor runs the whole section.
  const p = normalizeProject({ name, activeRoomId: start, rooms,
    ...(keep?.lighting ? { lighting: structuredClone(keep.lighting) } : {}) });
  return { p, doors: extra?.doors || new Map() };
}

// The building, fetched once (the embedded view asks for it before the planner has started).
let pending = null;
export function prefetchBuilding(params) {
  if (!params) return null;
  if (pending?.b !== params.b) {
    const p = fetch('/api/buildings/' + encodeURIComponent(params.b)).then(res => {
      if (!res.ok) throw new Error(res.status);
      return res.json();
    });
    p.catch(() => {});
    pending = { b: params.b, p };
  }
  return pending.p;
}

// Load the building, open the apartment and its corridor (or a floor) as a temporary project.
export async function openFloor({ b, apt, floor, street = false }) {
  const bld = await prefetchBuilding({ b });
  const a = apt ? bld.floorsData.flatMap(f => f.apartments || []).find(q => q.no === apt) : null;
  if (apt && !a) throw new Error('no apartment');
  const n = a ? a.floor : Math.min(floor, bld.floorsData.length);
  const { p, doors } = floorProject(bld, n, a, null, street && n === 1);
  openTemporary(p);
  return { bld, a, floor: n, doors };
}

const WALL = 5;      // half a partition: every shell room gets this much wall outside its outline, cm
const SLAB = 20;     // floor slab under the whole section, cm
let mats = null;
const materials = () => (mats ||= {
  wall: new THREE.MeshStandardMaterial({ color: '#e7e2d8', roughness: 0.95 }),
  floor: new THREE.MeshStandardMaterial({ color: '#c9c1b3', roughness: 1 }),
  core: new THREE.MeshStandardMaterial({ color: '#8f969d', roughness: 0.9 }),
  slab: new THREE.MeshStandardMaterial({ color: '#6c727a', roughness: 1 }),
  glass: new THREE.MeshStandardMaterial({ color: '#9cc3e6', roughness: 0.1, transparent: true, opacity: 0.35, depthWrite: false })
});

const PLATE = { free: '#2b8a3e', booked: '#d9480f', sold: '#868e96', rent: '#1971c2' };

// Plate over a door: the text on a stripe of the status colour.
function plate(text, status, wide = false) {
  const c = document.createElement('canvas');
  c.width = wide ? 256 : 128; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#2f3337';
  g.fillRect(0, 0, c.width, 64);
  g.fillStyle = PLATE[status] || '#868e96';
  g.fillRect(0, 54, c.width, 10);
  g.fillStyle = '#f4efe6';
  g.font = `600 ${wide ? 30 : 38}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(text), c.width / 2, 28);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(wide ? 0.64 : 0.32, 0.16), new THREE.MeshBasicMaterial({ map: tex }));
  mesh.userData.ownMaterial = true;
  return mesh;
}

// Lift front over a lift door: a steel jamb, two brushed leaves with the seam, the floor display above and
// the call button beside. Built facing +Z at the door's centre on the floor; the caller turns it to the room.
let liftTex = null;
function liftLeaves() {
  if (liftTex) return liftTex;
  const c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 128, 0);
  grad.addColorStop(0, '#9aa1a8'); grad.addColorStop(0.3, '#d5d9dd'); grad.addColorStop(0.5, '#aeb4ba');
  grad.addColorStop(0.7, '#d0d4d8'); grad.addColorStop(1, '#959ca3');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 256);
  g.globalAlpha = 0.12;                                       // brushed lines
  for (let y = 0; y < 256; y += 2) { g.fillStyle = (y * 7919) % 3 ? '#fff' : '#333'; g.fillRect(0, y, 128, 1); }
  g.globalAlpha = 1;
  g.fillStyle = '#2b2f33'; g.fillRect(63, 0, 2, 256);         // the seam between the leaves
  liftTex = new THREE.CanvasTexture(c);
  liftTex.colorSpace = THREE.SRGBColorSpace;
  return liftTex;
}

function display(text) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 48;
  const g = c.getContext('2d');
  g.fillStyle = '#111417'; g.fillRect(0, 0, 128, 48);
  g.fillStyle = '#ffb02e';
  g.font = '600 30px system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 64, 26);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function liftFront(width, n) {
  const w = width / 100, h = 2.1, g = new THREE.Group();
  const own = m => { m.userData.ownMaterial = true; return m; };
  const steel = new THREE.MeshStandardMaterial({ color: '#7d848b', roughness: 0.45 });
  const jamb = own(new THREE.Mesh(new THREE.PlaneGeometry(w + 0.16, h + 0.1), steel));
  jamb.position.set(0, (h + 0.1) / 2, 0.008);
  const leaves = own(new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: liftLeaves(), roughness: 0.35 })));
  leaves.position.set(0, h / 2, 0.011);
  const scr = own(new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.11), new THREE.MeshBasicMaterial({ map: display('▲▼ ' + n) })));
  scr.position.set(0, h + 0.2, 0.01);
  const plateMesh = own(new THREE.Mesh(new THREE.PlaneGeometry(0.07, 0.14), steel));
  plateMesh.position.set(w / 2 + 0.2, 1.1, 0.01);
  const btn = own(new THREE.Mesh(new THREE.CircleGeometry(0.018, 20), new THREE.MeshBasicMaterial({ color: '#e8f4ff' })));
  btn.position.set(w / 2 + 0.2, 1.1, 0.013);
  g.add(jamb, leaves, scr, plateMesh, btn);
  return g;
}

// The floor around the detailed part: other apartments (or the commercial units) as merged shells (floor, walls
// with window gaps, glass; their doors stay closed), the lift/stair core, the slab, plates over the doors.
// One mesh per material, no shadows.
export function floorContext({ bld, a, floor: n = a?.floor }) {
  const parts = { wall: [], floor: [], core: [], slab: [], glass: [] };
  const box = (kind, x, z, w, d, y0, h) => {
    if (w <= 0 || d <= 0 || h <= 0) return;
    const g = new THREE.BoxGeometry(w / 100, h / 100, d / 100);
    g.translate((x + w / 2) / 100, (y0 + h / 2) / 100, (z + d / 2) / 100);
    parts[kind].push(g);
  };
  const floor = bld.floorsData.find(f => f.n === n);
  const H = bld.section?.H || 280;
  // A shell room: q = rect in section coordinates, wins = its windows.
  const shell = (q, h, wins) => {
    const { x, y: z } = q;
    box('floor', x, z, q.w, q.h, -2, 2);
    for (const wall of ['north', 'south', 'west', 'east']) {
      const horiz = wall === 'north' || wall === 'south';
      const len = horiz ? q.w : q.h;
      const seg = (from, to, y0, hh) => {
        if (to <= from) return;
        if (horiz) box('wall', x + from, wall === 'north' ? z - WALL : z + q.h, to - from, WALL, y0, hh);
        else box('wall', wall === 'west' ? x - WALL : x + q.w, z + from, WALL, to - from, y0, hh);
      };
      const glass = (from, to, y0, hh) => {
        if (horiz) box('glass', x + from, (wall === 'north' ? z - WALL : z + q.h) + WALL / 2 - 0.5, to - from, 1, y0, hh);
        else box('glass', (wall === 'west' ? x - WALL : x + q.w) + WALL / 2 - 0.5, z + from, 1, to - from, y0, hh);
      };
      // Along the wall, with gaps for the windows (sill below, lintel above, glass in between).
      let at = 0;
      for (const w of wins.filter(w => w.wall === wall).sort((p, s) => p.offset - s.offset)) {
        const s = Math.max(at, w.offset), e = Math.min(len, w.offset + w.width);
        if (e <= s) continue;
        seg(at, s, 0, h);
        seg(s, e, 0, w.sill);
        seg(s, e, w.sill + w.height, h - w.sill - w.height);
        glass(s, e, w.sill, w.height);
        at = e;
      }
      seg(at, len, 0, h);
    }
    // Corners between the wall strips.
    for (const [cx, cz] of [[x - WALL, z - WALL], [x + q.w, z - WALL], [x - WALL, z + q.h], [x + q.w, z + q.h]]) box('wall', cx, cz, WALL, WALL, 0, h);
  };
  for (const o of floor?.apartments || []) {
    if (o.no === a?.no) continue;
    for (const r of o.plan) {
      const q = roomRect(r);
      shell({ x: o.at.x + q.x, y: o.at.y + q.y, w: q.w, h: q.h }, r.room.H || H, (r.openings || []).filter(w => w.kind === 'window'));
    }
  }
  const { core, section } = bld;
  // Commercial units: glazed all round where they face the street.
  for (const c of floor?.commercial || []) {
    const wins = [];
    for (const wall of ['north', 'south']) for (let x = 20; x + 260 <= c.w; x += 300) wins.push({ wall, offset: x, width: 260, sill: 0, height: 250 });
    shell(c, H, wins);
  }
  if (core) box('core', core.x, core.y, core.w, core.h, 0, H);
  // On the ground floor the strip west of the core (technical rooms) closes the lobby.
  if (floor?.lobby && core) box('core', floor.lobby.x, core.y + PART, core.x - floor.lobby.x - PART, floor.lobby.y + floor.lobby.h - core.y - PART, 0, H);
  if (section) box('slab', 0, 0, section.L, section.W, -2 - SLAB, SLAB);
  const group = new THREE.Group();
  group.name = 'floorContext';
  const m = materials();
  for (const [kind, list] of Object.entries(parts)) {
    if (!list.length) continue;
    const mesh = new THREE.Mesh(mergeGeometries(list), m[kind]);
    for (const g of list) g.dispose();
    mesh.castShadow = mesh.receiveShadow = false;
    if (kind === 'glass') mesh.renderOrder = 1;
    group.add(mesh);
  }
  // Plates over the neighbours' doors, on the corridor side; "for rent" over the doors to the shops.
  const c = bld.corridor;
  for (const o of floor?.apartments || []) {
    if (o.no === a?.no || !c) continue;
    const e = entranceDoor(o);
    if (!e) continue;
    const p = plate(o.no, o.status);
    const north = e.wall === 'north';
    p.position.set((e.x + e.width / 2) / 100, 2.32, (north ? c.y + 1 : c.y + c.h - 1) / 100);
    if (!north) p.rotation.y = Math.PI;
    group.add(p);
  }
  // Lifts and stairs in the core wall: on the ground floor the lobby's south wall, else the corridor's side.
  if (core && (floor?.lobby || c)) {
    const south = floor?.lobby ? true : core.y >= c.y + c.h;
    const z = (floor?.lobby ? core.y : south ? c.y + c.h : c.y) / 100 + (south ? -0.01 : 0.01);
    const turn = o => { o.rotation.y = south ? Math.PI : 0; return o; };
    for (const dx of [60, 200]) {
      const f = turn(liftFront(110, n));
      f.position.set((core.x + dx + 55) / 100, 0, z);
      group.add(f);
    }
    const st = turn(plate(t('floor3d.stairs'), 'sold', true));
    st.position.set((core.x + core.w - 105) / 100, 2.32, z);
    group.add(st);
  }
  if (floor?.lobby && core) {
    const lb = floor.lobby, zc = (lb.y + (core.y - lb.y) / 2) / 100;
    for (const west of [true, false]) {
      const p = plate(t('floor3d.rentSign'), 'rent', true);
      p.position.set((west ? lb.x + 1 : lb.x + lb.w - 1) / 100, 2.32, zc);
      p.rotation.y = west ? Math.PI / 2 : -Math.PI / 2;
      group.add(p);
    }
  }
  return group;
}

// ---------- walking: neighbours, lift, stairs ----------
let ctx = null, busy = false, hintShown = false, panel = null;

function overlayEl(id, cls) {
  let el = document.getElementById(id);
  if (!el) {
    el = Object.assign(document.createElement('div'), { id, className: cls });
    document.getElementById('view3d').append(el);
  }
  return el;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Doors handled here (true = the default opening is skipped): neighbours (sold → locked with a note, free /
 * booked → enter), the lifts (floor panel), the stairs (one floor up / down), the shops (locked, for rent).
 */
export function corridorDoor(roomId, doorId, enter = enterApartment) {
  const meta = ctx?.doors.get(`${roomId}:${doorId}`);
  if (!meta) return false;
  // The street doors lead back out to the showcase's site walk (only inside the showcase).
  if (meta.street) {
    if (window.parent === window) return false;
    window.parent.postMessage({ type: 'fsp3d:street' }, location.origin);
    return true;
  }
  if (meta.aptNo) {
    const o = ctx.bld.floorsData.flatMap(f => f.apartments || []).find(q => q.no === meta.aptNo);
    if (o?.status === 'sold') toast(t('floor3d.sold', { no: o.no }));
    else if (o) enter(o);
  } else if (meta.rent) toast(t('floor3d.rent'));
  else openPanel(meta.lift ? 'lift' : 'stairs');
  return true;
}

// Swap what is detailed behind a fade: the apartment `a` (with its corridor) or the floor `n` (at the lift).
async function swap(n, a, ms) {
  if (busy) return;
  busy = true;
  const fade = overlayEl('fade3d', 'fade3d');
  fade.style.transitionDuration = ms + 'ms';
  fade.classList.add('on');
  await sleep(ms);
  try {
    const keep = { lighting: state.lighting, finish: styleOf(state.style).finish };
    const { p, doors } = floorProject(ctx.bld, n, a, keep);
    openTemporary(p);
    ctx = { ...ctx, a, floor: n, doors };
    ctx.setContext(floorContext(ctx));
    try { window.parent?.postMessage({ type: 'fsp3d:place', no: a?.no ?? null, floor: n }, location.origin); } catch { /* ignore */ }
  } finally {
    await sleep(60);
    fade.classList.remove('on');
    busy = false;
  }
}

// The neighbour's apartment becomes the detailed one; finish level and light stay as they are.
export const enterApartment = a2 => swap(a2.floor, a2, 300);
export const goFloor = n => swap(n, null, 600);

// Lift: a button for every floor (the current one marked); stairs: one floor up / down.
function openPanel(kind) {
  ctx.release?.();
  const el = overlayEl('lift3d', 'lift3d');
  const floors = ctx.bld.floorsData.map(f => f.n);
  const nums = kind === 'lift' ? [...floors].reverse() : [ctx.floor + 1, ctx.floor - 1].filter(n => floors.includes(n));
  el.innerHTML = '';
  const head = Object.assign(document.createElement('div'), { className: 'lift3d-head' });
  head.append(Object.assign(document.createElement('b'), { textContent: t(kind === 'lift' ? 'floor3d.lift' : 'floor3d.stairs') }),
    Object.assign(document.createElement('span'), { textContent: t('floor3d.now', { n: ctx.floor }) }));
  const grid = Object.assign(document.createElement('div'), { className: 'lift3d-grid' + (kind === 'lift' ? '' : ' stairs') });
  for (const n of nums) {
    const b = Object.assign(document.createElement('button'), { type: 'button' });
    b.textContent = kind === 'lift' ? (n === 1 ? t('floor3d.liftLobby') : String(n))
      : t(n > ctx.floor ? 'floor3d.up' : 'floor3d.down', { n });
    if (n === ctx.floor) b.classList.add('on');
    b.addEventListener('click', () => { closePanel(); if (n !== ctx.floor) goFloor(n); });
    grid.append(b);
  }
  const close = Object.assign(document.createElement('button'), { type: 'button', className: 'lift3d-close', textContent: t('floor3d.close') });
  close.addEventListener('click', closePanel);
  el.append(head, grid, close);
  el.hidden = false;
  panel = kind;
  grid.querySelector('button:not(.on)')?.focus();
}

function closePanel() {
  const el = document.getElementById('lift3d');
  if (el) el.hidden = true;
  panel = null;
  ctx?.resume?.();
}

// Called once the embedded floor is shown: door hook, hints, Esc for the panel.
export function enableCorridor(floorCtx, { setContext, setDoorHook, release, resume }) {
  ctx = { ...floorCtx, setContext, release, resume };
  setDoorHook((roomId, doorId) => corridorDoor(roomId, doorId));
  window.addEventListener('keydown', e => { if (panel && e.code === 'Escape') { e.preventDefault(); closePanel(); } });
  const hint = () => {
    if (!hintShown && (state.activeRoomId === CORR_ID || state.activeRoomId === LOBBY_ID)) {
      hintShown = true;
      toast(t('floor3d.corrHint'));
    }
  };
  onChange(hint);
  hint();
}
