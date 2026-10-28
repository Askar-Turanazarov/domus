// Materials for the room and furniture.
// Quality 'simple': procedural Canvas textures; 'photo': CC0 photo textures from /textures (fallback to simple).
// 1 texture tile = 1 m.
import * as THREE from 'three';
import { surfacesOf, MAT_SETS } from '../style.js';

const SIZE = 512;
let mats = null;
const furnCache = new Map();
const finishCache = new Map();
let tex = null;
let photo = null;          // { floor, wall, wood, fabric } → { map, normalMap, roughnessMap } | null
let quality = 'simple';

const PHOTO_SETS = ['floor', 'wall', 'wood', 'fabric'];

// ---------- procedural generators ----------
function canvas(fill) {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const g = c.getContext('2d');
  if (fill) { g.fillStyle = fill; g.fillRect(0, 0, SIZE, SIZE); }
  return [c, g];
}

// Anisotropic filtering of the device tier (perf.js), set before the first texture is made.
let aniso = 8;
export const setAnisotropy = n => { aniso = n; };

// Photos are decoded off the main thread (createImageBitmap) where the browser can; plain <img> otherwise.
const bitmaps = typeof createImageBitmap === 'function'
  ? new THREE.ImageBitmapLoader().setOptions({ imageOrientation: 'flipY', premultiplyAlpha: 'none' }) : null;
async function loadTexture(url) {
  if (!bitmaps) return new THREE.TextureLoader().loadAsync(url);
  const t = new THREE.Texture(await bitmaps.loadAsync(url));
  t.flipY = false;   // already flipped while decoding
  t.needsUpdate = true;
  return t;
}

// 2K library maps (server/textureHD.js): only on a desktop of the "high" tier, never on a phone or in the mini app.
// The server says whether 2K is on (its kill switch); a 2K map that fails or is slow is taken from the 1K set
// in the repository instead, and after two such misses this session stays on 1K.
const HD_WAIT = 8000;
let hdWanted = false, hdOn = null, hdMisses = 0;
export const useHD = on => { hdWanted = !!on; };
async function hdReady() {
  if (!hdWanted || hdMisses >= 2) return false;
  hdOn ??= fetch('/api/textures/hd').then(r => r.json()).then(b => b.on === true, () => false);
  return hdOn;
}
async function loadLibMap(id, file) {
  const sd = `/textures/sets/${id}/${file}.jpg`;
  if (!(await hdReady())) return loadTexture(sd);
  let timer;
  try {
    return await Promise.race([loadTexture(`/textures/2k/${id}/${file}.jpg`),
      new Promise((_, no) => { timer = setTimeout(() => no(new Error('slow')), HD_WAIT); })]);
  } catch {
    hdMisses++;
    return loadTexture(sd);
  } finally {
    clearTimeout(timer);
  }
}

// Deterministic random so textures look the same on every rebuild.
function rng(seed) {
  return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
}

function toTexture(c, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = aniso;
  return t;
}

function grainLines(g, r, x, y, w, h, color, count, vertical = false) {
  g.strokeStyle = color;
  for (let i = 0; i < count; i++) {
    g.globalAlpha = 0.05 + r() * 0.12;
    g.lineWidth = 0.5 + r() * 1.5;
    g.beginPath();
    const off = r() * (vertical ? w : h);
    const amp = 1 + r() * 3, freq = 0.01 + r() * 0.03;
    for (let s = 0; s <= (vertical ? h : w); s += 8) {
      const wob = Math.sin(s * freq + off) * amp;
      const px = vertical ? x + off + wob : x + s;
      const py = vertical ? y + s : y + off + wob;
      s === 0 ? g.moveTo(px, py) : g.lineTo(px, py);
    }
    g.stroke();
  }
  g.globalAlpha = 1;
}

// Oak parquet: staggered planks 12.5 cm wide.
function parquet() {
  const [c, g] = canvas('#a87b4f');
  const [rc, rg] = canvas('#9a9a9a');
  const r = rng(7);
  const rowH = SIZE / 8;
  for (let row = 0; row < 8; row++) {
    let x = -r() * 200;
    while (x < SIZE) {
      const len = 160 + r() * 200;
      const y = row * rowH;
      const tone = 0.85 + r() * 0.3;
      g.fillStyle = `rgb(${190 * tone | 0}, ${140 * tone | 0}, ${90 * tone | 0})`;
      g.fillRect(x, y, len, rowH);
      grainLines(g, r, x, y, len, rowH, '#5a3a1e', 14);
      rg.fillStyle = `rgb(${150 + r() * 40 | 0},${150 + r() * 40 | 0},${150 + r() * 40 | 0})`;
      rg.fillRect(x, y, len, rowH);
      // Seams.
      g.fillStyle = 'rgba(60,35,15,.55)';
      g.fillRect(x, y, 1.5, rowH);
      x += len;
    }
    g.fillStyle = 'rgba(60,35,15,.6)';
    g.fillRect(0, row * rowH, SIZE, 1.5);
  }
  return { map: toTexture(c), roughnessMap: toTexture(rc, false) };
}

// Light plaster with fine speckle.
function plaster() {
  const [c, g] = canvas('#ece6dc');
  const r = rng(11);
  for (let i = 0; i < 9000; i++) {
    g.fillStyle = r() > 0.5 ? 'rgba(255,255,255,.08)' : 'rgba(120,100,80,.06)';
    const s = 1 + r() * 3;
    g.fillRect(r() * SIZE, r() * SIZE, s, s);
  }
  return { map: toTexture(c) };
}

// Neutral wood grain (tinted by the item colour).
function woodGrain() {
  const [c, g] = canvas('#e9e4dd');
  const r = rng(23);
  grainLines(g, r, 0, 0, SIZE, SIZE, '#6b5a48', 70, true);
  return { map: toTexture(c) };
}

// Neutral fabric weave (tinted by the item colour).
function fabric() {
  const [c, g] = canvas('#e6e6e6');
  const r = rng(31);
  for (let y = 0; y < SIZE; y += 4) {
    g.fillStyle = `rgba(0,0,0,${0.03 + r() * 0.04})`;
    g.fillRect(0, y, SIZE, 2);
  }
  for (let x = 0; x < SIZE; x += 4) {
    g.fillStyle = `rgba(255,255,255,${0.04 + r() * 0.05})`;
    g.fillRect(x, 0, 2, SIZE);
  }
  for (let i = 0; i < 4000; i++) {
    g.fillStyle = `rgba(0,0,0,${r() * 0.05})`;
    g.fillRect(r() * SIZE, r() * SIZE, 2, 2);
  }
  return { map: toTexture(c) };
}

// Laminate: long planks 20 cm wide, greyish oak.
function laminate() {
  const [c, g] = canvas('#b9a58a');
  const r = rng(41);
  const rowH = SIZE / 5;
  for (let row = 0; row < 5; row++) {
    const y = row * rowH, seam = r() * SIZE, tone = 0.9 + r() * 0.2;
    g.fillStyle = `rgb(${185 * tone | 0}, ${165 * tone | 0}, ${138 * tone | 0})`;
    g.fillRect(0, y, SIZE, rowH);
    grainLines(g, r, 0, y, SIZE, rowH, '#4d3b28', 18);
    g.fillStyle = 'rgba(50,35,20,.5)';
    g.fillRect(seam, y, 1.5, rowH);
    g.fillRect(0, y, SIZE, 1.5);
  }
  return { map: toTexture(c) };
}

// Ceramic tile 50×50 cm with grout.
function tile() {
  const [c, g] = canvas('#bdb9b2');
  const r = rng(53);
  const s = SIZE / 2;
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      const tone = 0.96 + r() * 0.06;
      g.fillStyle = `rgb(${232 * tone | 0}, ${229 * tone | 0}, ${223 * tone | 0})`;
      g.fillRect(i * s + 2, j * s + 2, s - 4, s - 4);
      for (let k = 0; k < 500; k++) {
        g.fillStyle = `rgba(120,110,100,${r() * 0.08})`;
        g.fillRect(i * s + 2 + r() * (s - 4), j * s + 2 + r() * (s - 4), 2, 2);
      }
    }
  }
  return { map: toTexture(c) };
}

// Short-pile carpet: dense noise.
function carpet() {
  const [c, g] = canvas('#b3a692');
  const r = rng(61);
  for (let i = 0; i < 40000; i++) {
    g.fillStyle = r() > 0.5 ? `rgba(255,255,255,${r() * 0.1})` : `rgba(60,50,40,${r() * 0.12})`;
    g.fillRect(r() * SIZE, r() * SIZE, 1 + r() * 2, 1 + r() * 2);
  }
  return { map: toTexture(c) };
}

// Wallpaper: soft vertical stripes with a small diamond print (neutral, tinted by the wall colour).
function wallpaper() {
  const [c, g] = canvas('#f4f1ec');
  const step = SIZE / 8;
  for (let i = 0; i < 8; i++) {
    g.fillStyle = i % 2 ? 'rgba(0,0,0,.035)' : 'rgba(255,255,255,.05)';
    g.fillRect(i * step, 0, step, SIZE);
  }
  g.fillStyle = 'rgba(120,100,80,.12)';
  for (let x = step / 2; x < SIZE; x += step) {
    for (let y = step / 4; y < SIZE; y += step / 2) {
      g.beginPath();
      g.moveTo(x, y - 6); g.lineTo(x + 4, y); g.lineTo(x, y + 6); g.lineTo(x - 4, y);
      g.fill();
    }
  }
  return { map: toTexture(c) };
}

// Brick 25 cm × ~7 cm in half-bond (light neutral, tinted by the wall colour); mortar is lighter.
function brick() {
  const [c, g] = canvas('#f2eee8');
  const r = rng(71);
  const rows = 14, bw = SIZE / 4, bh = SIZE / rows;
  for (let row = 0; row < rows; row++) {
    const off = row % 2 ? bw / 2 : 0;
    for (let i = -1; i < 4; i++) {
      const tone = 0.78 + r() * 0.2;
      g.fillStyle = `rgb(${230 * tone | 0}, ${222 * tone | 0}, ${214 * tone | 0})`;
      g.fillRect(i * bw + off + 2, row * bh + 2, bw - 4, bh - 4);
    }
  }
  for (let k = 0; k < 6000; k++) {
    g.fillStyle = `rgba(70,50,40,${r() * 0.07})`;
    g.fillRect(r() * SIZE, r() * SIZE, 2, 2);
  }
  return { map: toTexture(c) };
}

// Wall panels: vertical boards ≈ 17 cm with grooves.
function panels() {
  const [c, g] = canvas('#ece6dc');
  const r = rng(83);
  const n = 6, pw = SIZE / n;
  for (let i = 0; i < n; i++) {
    g.fillStyle = `rgba(255,255,255,${r() * 0.08})`;
    g.fillRect(i * pw, 0, pw, SIZE);
    grainLines(g, r, i * pw, 0, pw, SIZE, '#8a7a66', 6, true);
    g.fillStyle = 'rgba(60,45,30,.35)';
    g.fillRect(i * pw, 0, 2, SIZE);
  }
  return { map: toTexture(c) };
}

const EXTRA = { laminate, tile, carpet, wallpaper, brick, panels };
// New finishes without their own generator: base pattern (or the plaster of the base set) and a colour.
const LOOK = {
  herringbone: ['parquet', '#d9b48a'], parquetDark: ['parquet', '#6e4e36'], marble: ['tile', '#f1efec'],
  plaster: ['plaster', '#efe9df'], concrete: ['plaster', '#a9a7a3'], tileBath: ['tile', '#ffffff'],
  screed: ['plaster', '#9d9a95'], putty: ['plaster', '#f6f5f2'], blocks: ['brick', '#b9b4ad']
};

function textures() {
  if (!tex) tex = { parquet: parquet(), plaster: plaster(), wood: woodGrain(), fabric: fabric() };
  return tex;
}

// Extra finishes are generated on first use.
function extra(name) {
  const T = textures();
  if (!T[name]) T[name] = EXTRA[name]();
  return T[name];
}

// ---------- photo textures ----------
// The visitor's own photos (colour map only, kept in this browser): { floor: url | null, ... }.
const customUrls = () => import('../customTex.js').then(m => m.customUrls(PHOTO_SETS)).catch(() => ({}));

async function loadSet(name, customUrl, tick = () => {}) {
  const load = async (file, srgb, url = `/textures/${name}/${file}.jpg`) => {
    const t = await loadTexture(url);
    tick();
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = aniso;
    return t;
  };
  if (customUrl) {
    // The built-in normal/roughness maps do not match a foreign photo, so use the colour only.
    try {
      const map = await load('color', true, customUrl);
      tick(2);   // no normal / roughness maps for a custom photo
      return { map, custom: true };
    } catch { /* fall back to built-in */ }
  }
  try {
    const [map, normalMap, roughnessMap] = await Promise.all([
      load('color', true), load('normal', false), load('roughness', false)
    ]);
    // Upholstery is tinted by the item colour, so its photo must be neutral grey.
    return { map: name === 'fabric' ? greyscale(map) : map, normalMap, roughnessMap };
  } catch {
    return null;
  }
}

function greyscale(t) {
  const img = t.image;
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height);
  const px = d.data;
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) sum += 0.3 * px[i] + 0.59 * px[i + 1] + 0.11 * px[i + 2];
  const k = 215 / (sum / (px.length / 4));          // normalise to a light grey
  for (let i = 0; i < px.length; i += 4) {
    const v = Math.min(255, (0.3 * px[i] + 0.59 * px[i + 1] + 0.11 * px[i + 2]) * k);
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  g.putImageData(d, 0, 0);
  t.dispose();
  return toTexture(c);
}

export const PHOTO_MB = 2;    // the four base photo sets on disk, about

// The base photo sets are loaded (Photo quality is then applied at once).
export const photoReady = () => !!photo;

/** Switch texture quality. Resolves to false if photo textures are missing. onProgress(done, total) — files loaded. */
export async function setQuality(q, onProgress) {
  let ok = true;
  if (q === 'photo' && !photo) {
    const custom = await customUrls();
    const total = PHOTO_SETS.length * 3;
    let done = 0;
    onProgress?.(0, total);
    const tick = (k = 1) => onProgress?.(done += k, total);
    const sets = await Promise.all(PHOTO_SETS.map(n => loadSet(n, custom[n], tick)));
    photo = Object.fromEntries(PHOTO_SETS.map((n, i) => [n, sets[i]]));
    ok = sets.every(Boolean);
  } else if (q === 'photo') {
    ok = Object.values(photo).every(Boolean);
  }
  quality = q;
  mats = null;              // rebuilt on next getMats()
  furnCache.clear();
  finishCache.clear();
  return ok;
}

export const getQuality = () => quality;

/** Forget loaded photo textures (after an upload / reset) so the next setQuality reloads them. */
export function resetPhoto() {
  if (photo) for (const set of Object.values(photo)) if (set) for (const t of Object.values(set)) t?.isTexture && t.dispose();
  photo = null;
}

// ---------- photo library (public/textures/library.json) ----------
// Sets are loaded lazily in Photo quality; until a set arrives (or if it is missing) the procedural look is used.
// When a set finishes loading, the listeners rebuild the scene.
const lib = new Map();      // id → texture set | 'loading' | null (failed)
let libIndex = null;        // Promise<[{ id, tile, available, ... }]>
let libServer = false;      // the index came from the server: it can download missing sets
const libListeners = [], missingListeners = [];
let pending = 0;            // library sets being loaded

export const onLibLoaded = fn => libListeners.push(fn);
// A set the finish needs is not on disk (it has to be downloaded from ambientCG first): fn(entry).
export const onLibMissing = fn => missingListeners.push(fn);
export const libPending = () => pending;

// The server says which sets are on disk; a static host has only library.json (bundled sets are there).
export function libraryIndex() {
  if (!libIndex) {
    libIndex = fetch('/api/textures/library').then(r => r.ok ? r.json() : Promise.reject(new Error(r.status)))
      .then(list => { libServer = true; return list; })
      .catch(() => fetch('/textures/library.json').then(r => r.ok ? r.json() : [])
        .then(l => l.map(e => ({ available: !!e.bundled, ...e }))))
      .catch(() => []);
  }
  return libIndex;
}

/** The server can download library sets (not a static host). */
export const canFetchLib = () => libServer;

// Download a library set through the server, then load it into the scene. The server downloads one set at a
// time ('busy', e.g. the facade sets for another visitor): wait and retry.
// Sets the server could not download in this session: not asked for again (the simple texture stays).
const failedSets = new Set((() => {
  try { return JSON.parse(sessionStorage.getItem('fsp3d.libFail') || '[]'); } catch { return []; }
})());
function setFailed(id) {
  failedSets.add(id);
  try { sessionStorage.setItem('fsp3d.libFail', JSON.stringify([...failedSets])); } catch { /* ignore */ }
}

export async function fetchLibSet(id) {
  if (failedSets.has(id)) throw new Error('download_failed');
  try {
    await askServer(id);
  } catch (e) {
    if (e.message !== 'busy') setFailed(id);
    throw e;
  }
}

async function askServer(id) {
  for (let tries = 0; ; tries++) {
    // A request never hangs: the server answers within its own limit, this is the backstop.
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 120 * 1000);
    let res;
    try {
      res = await fetch('/api/textures/fetch/' + encodeURIComponent(id), { method: 'POST', signal: ctrl.signal });
    } catch {
      throw new Error('download_failed');
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) break;
    const body = await res.json().catch(() => ({}));
    if (res.status !== 429 || tries > 60) throw new Error(body.error || 'download_failed');
    await new Promise(r => setTimeout(r, 2000));
  }
  libIndex = null;
  lib.delete(id);
  mats = null;
  furnCache.clear();
  finishCache.clear();
  libListeners.forEach(fn => fn(id, 'fetched'));   // rebuild: the scene asks for the set again and loads it
}

async function loadLib(id) {
  const entry = (await libraryIndex()).find(e => e.id === id);
  if (!entry) return null;
  if (!entry.available) {
    if (!failedSets.has(id)) missingListeners.forEach(fn => fn(entry));
    return null;
  }
  const rep = 1 / (entry.tile || 1);
  const load = async (file, srgb) => {
    // Bundled sets are in the repository (1K, or 2K from Supabase on a strong desktop), the others are downloaded on demand into lib/.
    const t = await (entry.bundled ? loadLibMap(id, file) : loadTexture(`/textures/lib/${id}/${file}.jpg`));
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = aniso;
    // Non-square images (e.g. 1024×512) keep their aspect: one copy is tile × tile·h/w metres.
    const { width: w = 1, height: h = 1 } = t.image || {};
    t.repeat.set(rep, rep * w / h);
    return t;
  };
  // A set may have only some of the maps (library.json "maps", e.g. quilted leather: normal / roughness).
  const KEYS = { color: 'map', normal: 'normalMap', roughness: 'roughnessMap', opacity: 'alphaMap' };
  const want = Array.isArray(entry.maps) ? entry.maps.filter(k => KEYS[k]) : ['color', 'normal', 'roughness'];
  try {
    const got = await Promise.all(want.map(k => load(k, k === 'color')));
    return Object.fromEntries(want.map((k, i) => [KEYS[k], got[i]]));
  } catch { return null; }
}

// Loaded library set or null (starts loading on first request in Photo quality).
function libSet(id) {
  if (!id || quality !== 'photo') return null;
  const v = lib.get(id);
  if (v === undefined) {
    lib.set(id, 'loading');
    pending++;
    loadLib(id).then(set => {
      pending--;
      lib.set(id, set);
      if (!set) { libListeners.forEach(fn => fn(id, false)); return; }
      mats = null;
      furnCache.clear();
      finishCache.clear();
      libListeners.forEach(fn => fn(id, true));
    });
    return null;
  }
  return v === 'loading' ? null : v;
}

/** Start loading library sets (e.g. a luxe collection's packs): missing ones go to onLibMissing → download. */
export function preloadSets(ids) { for (const id of ids) libSet(id); }

// Texture set for a surface in the current quality (falls back to procedural).
function surface(name) {
  const p = quality === 'photo' && photo && photo[name];
  if (p) return { ...p, photo: true, custom: !!p.custom };
  const T = textures();
  const simple = { floor: T.parquet, wall: T.plaster, wood: T.wood, fabric: T.fabric }[name];
  return { ...simple, photo: false };
}

// Photo maps are already coloured: tint them only lightly with the item colour (custom ones barely).
// white: how far the colour moves to white (a plain plaster photo takes the paint colour almost as it is).
function tint(color, isPhoto, isCustom = false, white = 0.45) {
  if (!isPhoto) return new THREE.Color(color);
  return new THREE.Color(color).lerp(new THREE.Color('#ffffff'), isCustom ? 0.8 : white);
}

const maps = ({ map, normalMap, roughnessMap }) => {
  const m = {};
  if (map) m.map = map;
  if (normalMap) m.normalMap = normalMap;
  if (roughnessMap) m.roughnessMap = roughnessMap;
  return m;
};

// ---------- materials ----------
export function getMats() {
  if (mats) return mats;
  const floor = surface('floor'), wall = surface('wall'), wood = surface('wood');
  mats = {
    floor: new THREE.MeshStandardMaterial({ ...maps(floor), roughness: floor.photo ? 1 : 0.75 }),
    wall: new THREE.MeshStandardMaterial({ ...maps(wall), color: wall.photo ? '#f3eee6' : '#ffffff', roughness: 0.95 }),
    ceiling: new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1 }),
    plinth: new THREE.MeshStandardMaterial({ color: '#f7f5f0', roughness: 0.5 }),
    frame: new THREE.MeshStandardMaterial({ color: '#fafafa', roughness: 0.4 }),
    glass: new THREE.MeshStandardMaterial({ color: '#cfe8ff', roughness: 0.05, transparent: true, opacity: 0.25 }),
    sky: new THREE.MeshBasicMaterial({ color: '#bfe3ff' }),
    door: new THREE.MeshStandardMaterial({ ...maps(wood), color: tint('#d9c7ad', wood.photo), roughness: 0.6 }),
    metal: new THREE.MeshStandardMaterial({ color: '#c0c4cc', roughness: 0.3, metalness: 0.9 }),
    lampShade: new THREE.MeshStandardMaterial({ color: '#fff7e0', emissive: '#ffe9b0', emissiveIntensity: 2 })
  };
  return mats;
}

/**
 * Floor and wall materials for a room style (see style.js); accent — the accent-wall material.
 * Parquet and paint use the photo set in Photo quality, the other finishes are procedural.
 */
export function finishMats(style) {
  const key = JSON.stringify(style);
  if (finishCache.has(key)) return finishCache.get(key);
  const S = surfacesOf(style);
  // Procedural texture of a finish value: own generator, the base parquet / plaster, or a LOOK alias.
  const simple = (v, base) => {
    if (v === base) return { tex: surface(base === 'parquet' ? 'floor' : 'wall'), color: null };
    const [gen, color] = LOOK[v] || [v, null];
    const T = textures();
    const tex = gen === 'parquet' ? T.parquet : gen === 'plaster' ? T.plaster : extra(gen);
    return { tex: { ...tex, photo: false }, color };
  };
  const ROUGH = { parquet: 0.75, herringbone: 0.75, parquetDark: 0.7, laminate: 0.55, tile: 0.25, marble: 0.15, carpet: 1, screed: 0.95 };
  const fl = libSet(S.floorSet);
  const fs = fl ? { tex: { ...fl, photo: true }, color: null } : simple(S.floor, 'parquet');
  const floor = new THREE.MeshStandardMaterial({
    ...maps(fs.tex), color: fs.color || '#ffffff', roughness: fs.tex.photo ? 1 : ROUGH[S.floor] ?? 0.8
  });
  const wl = libSet(S.wallSet);
  const ws = wl ? { tex: { ...wl, photo: true }, color: null } : simple(S.wall, 'paint');
  // Bare finishes keep their own colour; painted ones are tinted by the chosen wall colour.
  const own = S.wall === 'blocks' || S.wall === 'putty' || S.wall === 'concrete';
  const wallMat = color => new THREE.MeshStandardMaterial({
    ...maps(ws.tex),
    color: own ? (ws.tex.photo ? '#ffffff' : ws.color) : tint(color, ws.tex.photo, ws.tex.custom, S.wall === 'paint' ? 0.12 : 0.45),
    roughness: S.wall === 'panels' ? 0.6 : S.wall === 'tileBath' ? 0.3 : 0.95
  });
  const s = style || {};
  const ceiling = S.ceiling === 'concrete'
    ? new THREE.MeshStandardMaterial({ color: '#a8a6a2', roughness: 1 })
    : getMats().ceiling;
  const res = {
    floor, wall: wallMat(S.wallColor), accent: S.accent ? wallMat(s.accentColor || '#8fa3b8') : null,
    ceiling, plinth: S.plinth, doorLeaves: S.doorLeaves
  };
  finishCache.set(key, res);
  return res;
}

// Luxe collection materials (style.js STYLE_MATS): the photo set (MAT_SETS) once it is loaded, a procedural look
// until then. base — own colour when the item has none; photo — how the set is used.
const LUXE = {
  veneer: { base: '#6e4a32', wood: true, coat: 0.6 },
  burl: { base: '#5b3a25', wood: true, coat: 0.85 },
  oak: { base: '#cfb38c', wood: true, coat: 0.1 },
  espresso: { base: '#4b3527', wood: true, coat: 0.15 },
  boucle: { base: '#ece6da', fabric: true, sheen: 0.5, sheenR: 0.9 },
  velvet: { base: '#33405a', fabric: true, sheen: 1, sheenR: 0.35 },
  linen: { base: '#d9cfbf', fabric: true, sheen: 0.25, sheenR: 0.8 },
  leatherQuilt: { base: '#3a2a22', leather: true },
  leatherCream: { base: '#e7d9c2', leather: true },
  leatherBlack: { base: '#1d1c1e', leather: true },
  leatherTan: { base: '#9a6a43', leather: true },
  lacquer: { base: '#1b1b1d' },
  brushedBrass: { base: '#c9a45c', metal: true, rough: 0.32 },
  bronze: { base: '#7c5b3c', metal: true, rough: 0.4 },
  marble: { base: '#efece6', stone: true, coat: 0.7 },
  marbleNero: { base: '#1e1d1f', stone: true, coat: 0.8 },
  travertine: { base: '#d8c7aa', stone: true, coat: 0.15 },
  smokedGlass: { base: '#2c2a27' }
};
export const LUXE_KINDS = Object.keys(LUXE);

function luxeMat(kind, color) {
  const L = LUXE[kind], set = libSet(MAT_SETS[kind]);
  const own = color || L.base;
  // Photo maps are already coloured: the item colour only tints them (the quilt set has no colour map).
  const col = set?.map ? tint(own, true, false, 0.6) : own;
  const P = o => new THREE.MeshPhysicalMaterial(o);
  if (kind === 'lacquer') return P({ color: own, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.04 });
  if (kind === 'smokedGlass') return P({ color: L.base, roughness: 0.04, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false });
  if (L.wood) {
    const src = set || surface('wood');
    return P({ ...maps(src), color: set ? col : tint(own, src.photo), roughness: set ? 1 : 0.5, clearcoat: L.coat, clearcoatRoughness: 0.22 });
  }
  // Upholstery keeps the collection colour exactly: the photo set gives only the weave / grain (normal, roughness).
  const relief = src => maps({ normalMap: src.normalMap, roughnessMap: src.roughnessMap });
  if (L.fabric) {
    const src = set || surface('fabric');
    return P({ ...(set ? relief(set) : maps(src)), color: own, roughness: 1, sheen: L.sheen, sheenRoughness: L.sheenR,
      sheenColor: new THREE.Color(own).lerp(new THREE.Color('#ffffff'), 0.35) });
  }
  if (L.leather) return P({ ...(set ? relief(set) : {}), color: own, roughness: set ? 1 : 0.5, clearcoat: 0.3, clearcoatRoughness: 0.45 });
  if (L.metal) return P({ ...(set ? maps(set) : {}), color: set ? '#ffffff' : L.base, metalness: 1, roughness: set ? 1 : L.rough });
  // stone
  return P({ ...(set ? maps(set) : {}), color: set ? '#ffffff' : own, roughness: set ? 1 : 0.22, clearcoat: L.coat, clearcoatRoughness: 0.08 });
}

const HIGHLIGHT = {
  ok: null,
  bad: { color: '#ff1a1a', intensity: 0.45 },
  found: { color: '#2fbf4a', intensity: 0.4 }
};

/**
 * Furniture material, cached by kind + colour + status.
 * kind: 'wood' | 'fabric' | 'soft' (light fabric) | 'dark' | 'plain' (untextured colour) | 'solid' | 'gloss' | 'brass' | 'black' | 'metal'
 * Materials are shared through the cache: disposeGroup frees geometry only.
 */
export function furnitureMat(kind, color, status = 'ok') {
  const key = `${kind}|${color}|${status}`;
  if (furnCache.has(key)) return furnCache.get(key);
  const wood = surface('wood'), fab = surface('fabric');
  let m;
  switch (kind) {
    case 'wood': m = new THREE.MeshStandardMaterial({ ...maps(wood), color: tint(color, wood.photo, wood.custom), roughness: 0.55 }); break;
    case 'fabric': m = new THREE.MeshStandardMaterial({ ...maps(fab), color: fab.custom ? tint(color, true, true) : color, roughness: 0.95 }); break;
    case 'soft': m = new THREE.MeshStandardMaterial({ ...maps(fab), color: '#f4f1ea', roughness: 0.95 }); break;
    case 'dark': m = new THREE.MeshStandardMaterial({ ...maps(wood), color: wood.photo ? '#6b5442' : '#4a3a2c', roughness: 0.6 }); break;
    case 'plain': m = new THREE.MeshStandardMaterial({ color, roughness: 0.35 }); break;   // enamel, plastic, stone
    case 'solid': m = new THREE.MeshStandardMaterial({ color, roughness: 0.7 }); break;    // matte laminate / paint
    case 'gloss': m = new THREE.MeshStandardMaterial({ color, roughness: 0.1, metalness: 0.05 }); break;
    case 'brass': m = new THREE.MeshStandardMaterial({ color: '#b08d57', roughness: 0.35, metalness: 0.9 }); break;
    case 'black': m = new THREE.MeshStandardMaterial({ color: '#26272b', roughness: 0.5, metalness: 0.6 }); break;
    // Sanitary ware and enamel: glossy clear coat over a soft base.
    case 'ceramic': m = new THREE.MeshPhysicalMaterial({ color: color || '#f6f6f3', roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.06 }); break;
    case 'chrome': m = new THREE.MeshStandardMaterial({ color: '#e8eaee', roughness: 0.12, metalness: 1 }); break;
    // Clear glass: cheap transparency instead of transmission (keeps FPS).
    case 'glass': m = new THREE.MeshPhysicalMaterial({ color: '#dfeef2', roughness: 0.05, metalness: 0, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }); break;
    case 'leather': {
      const lt = libSet('leather');
      m = new THREE.MeshPhysicalMaterial({ ...maps(lt || fab), color: lt ? tint(color, true) : color, roughness: lt ? 1 : 0.5, clearcoat: 0.35, clearcoatRoughness: 0.4 });
      break;
    }
    case 'screen': m = new THREE.MeshPhysicalMaterial({ color: '#0b0c0f', roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.02 }); break;
    case 'leaf': m = new THREE.MeshStandardMaterial({ color: color || '#4f7d45', roughness: 0.7, side: THREE.DoubleSide }); break;
    case 'rug': m = new THREE.MeshStandardMaterial({ ...maps(fab), color, roughness: 1 }); break;
    default: m = LUXE[kind] ? luxeMat(kind, color) : new THREE.MeshStandardMaterial({ color: '#b8bcc4', roughness: 0.3, metalness: 0.9 });
  }
  const hl = HIGHLIGHT[status];
  if (hl) { m.emissive.set(hl.color); m.emissiveIntensity = hl.intensity; }
  furnCache.set(key, m);
  return m;
}
