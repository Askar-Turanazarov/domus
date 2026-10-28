// The building outside in 3D (showcase main view): light stone facade with light frames in deep reveals, metal
// sills, balconies with glass rails at the living rooms, stone pilasters between apartments, a cornice and parapet,
// a dark stone ground floor with shop canopies and a canopy over the entrance, the lift room on the roof.
// Walls, bands and frames are merged into one mesh per material; the glass is one InstancedMesh with a room
// behind every window (windows.js), lit at night, tinted per apartment. Drawn only when something changes.
// Scene units: metres; the building stands centred on the origin, south (the entrance) towards +z.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SLAB } from '../facade.js';
import { SETTINGS, readPref, tierFor, photoAuto } from '../3d/perf.js';
import { createSite } from './site.js';
import { createStreetWalk } from './streetWalk.js';
import { applyPhotoFacade, holdPhotos, PHOTO_UV } from './facadeTex.js';
import { TWEEN_SEC, easeInOut } from '../lighting.js';
import { createWindows } from './windows.js';
import { shadeStrips } from '../3d/softShadows.js';

const M = 0.01;          // cm → m
const T = 0.3;           // outer wall thickness, m
const GLASS_D = 0.05;    // glass plane, m from the inner face (the reveal is T − GLASS_D = 25 cm deep)
const PARAPET = 1.1;

export const TIMES = {
  // Day: the sun 40° off the main (south) facade and 34° high, the sky light lower than before, so reveals,
  // balconies and the cornice cast shadows that read.
  day: { top: '#2f6cbc', mid: '#8fbbe8', bottom: '#e6eef4', sun: '#fff0d6', sunI: 3.1, elev: 34, azim: -40,
    hemi: 0.72, sky: '#cfe2ff', ground: '#a8936f', fog: '#dbe5ee', exposure: 0.95, lit: 0, lamp: 0 },
  evening: { top: '#2a3c6e', mid: '#a98a8a', bottom: '#f0b98e', sun: '#ffbf85', sunI: 2.0, elev: 9, azim: -62,
    hemi: 0.55, sky: '#ffcfaa', ground: '#4f4339', fog: '#e7b38e', exposure: 1.05, lit: 0.3, lamp: 0.6 },
  night: { top: '#03060f', mid: '#0b1428', bottom: '#1a2744', sun: '#9fb4ff', sunI: 0.3, elev: 42, azim: 35,
    hemi: 0.16, sky: '#33446f', ground: '#0d0d10', fog: '#111a2d', exposure: 1.15, lit: 0.55, lamp: 1 }
};

// A time of day between two presets (k = 0 … 1): numbers and colours blend, so the sky, the sun and the lamps
// move smoothly as in the rooms' 3D.
const NUMS = ['sunI', 'elev', 'azim', 'hemi', 'exposure', 'lit', 'lamp'];
const COLS = ['top', 'mid', 'bottom', 'sun', 'sky', 'ground', 'fog'];
export function mixTimes(a, b, k) {
  const o = {};
  for (const n of NUMS) o[n] = a[n] + (b[n] - a[n]) * k;
  for (const c of COLS) o[c] = new THREE.Color(a[c]).lerp(new THREE.Color(b[c]), k);
  return o;
}
const LAMPS_ON = 0.6;
const BALCONY = new Set(['living', 'kitchenLiving']);   // rooms whose window gets a balcony     // the evening level: strips, letters and doors fully lit from here


// Seamed stone slabs 150 × 75 cm, in world-space UVs (1 texture = 3 × 1.5 m).
function tileTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#ebe5db';
  g.fillRect(0, 0, 512, 256);
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    const v = 226 + Math.floor(rnd() * 14);
    g.fillStyle = `rgb(${v + 6},${v + 1},${v - 7})`;
    g.fillRect(x * 256 + 2, y * 128 + 2, 252, 124);
  }
  for (let i = 0; i < 1600; i++) {
    g.fillStyle = `rgba(${rnd() < 0.5 ? '255,255,255' : '120,110,95'},${0.05 + rnd() * 0.06})`;
    g.fillRect(rnd() * 512, rnd() * 256, 1 + rnd() * 2, 1 + rnd() * 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.repeat.set(2, 2);     // the wall UVs repeat every 6 × 3 m (the photo panels), this tile is 3 × 1.5
  return t;
}

// Box UVs from world position (u along the face, v up), so tiles keep their size on every box.
function worldUV(geo, w = 2.4, h = 1.2) {
  const p = geo.attributes.position, n = geo.attributes.normal, uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const nx = Math.abs(n.getX(i)), ny = Math.abs(n.getY(i));
    const u = ny > 0.5 ? p.getX(i) : nx > 0.5 ? p.getZ(i) : p.getX(i);
    const v = ny > 0.5 ? p.getZ(i) : p.getY(i);
    uv.setXY(i, u / w, v / h);
  }
  return geo;
}

function skyMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color() }, mid: { value: new THREE.Color() }, bottom: { value: new THREE.Color() } },
    vertexShader: 'varying vec3 vP; void main() { vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 bottom; varying vec3 vP;
      void main() { float h = vP.y; vec3 c = h > 0.0 ? mix(mid, top, pow(clamp(h * 1.6, 0.0, 1.0), 0.8)) : mix(mid, bottom, clamp(-h * 6.0, 0.0, 1.0));
      if (h > -0.02 && h < 0.18) c = mix(c, bottom, (1.0 - smoothstep(0.0, 0.18, h)) * 0.75);
      gl_FragColor = vec4(c, 1.0);
      #include <colorspace_fragment>
      }`
  });
}

/**
 * createExterior(container, { bld, fac, title, onHover(aptNo|null, event), onPick(aptNo), onFloor(n) })
 * → { paint({ colorOf, dim, hover }), setFloor, setTime, setAuto, setTitle, pause, flyToFloor, requestRender, refreshPhoto }
 * colorOf(aptNo) → CSS colour or null (neutral glass); dim(aptNo) → true when it does not match the filters.
 */
// "ПОДЪЕЗД 1" → ['ПОДЪЕЗД', '1'], "1-PODYEZD" → ['PODYEZD', '1'].
function splitNo(text) {
  const m = text.match(/\d+/);
  return m ? [text.replace(m[0], '').replace(/^[\s-]+|[\s-]+$/g, ''), m[0]] : [text, ''];
}

export function createExterior(container, { bld, fac, title = '', entrance = 'ENTRANCE 1', onHover = () => {}, onPick = () => {}, onFloor = () => {}, onDoor = null, onWalk = null, onCue = null, tier: forced = null }) {
  const tierName = forced ?? tierFor(readPref()), tier = SETTINGS[tierName];   // forced 'low' — the mini app (11 §8)
  let entranceText = entrance;
  const renderer = new THREE.WebGLRenderer({ antialias: tier.antialias });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, tier.pixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  container.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 1500);
  const L = fac.L * M, W = fac.W * M, level = fac.level * M, top = fac.floors * level;
  const hx = L / 2, hz = W / 2;

  // ---------- sky, fog, light ----------
  const skyMat = skyMaterial();
  const sky = new THREE.Mesh(new THREE.SphereGeometry(600, 32, 16), skyMat);
  scene.add(sky);
  scene.fog = new THREE.Fog('#dfe7ee', 160, 520);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(sky.geometry, skyMat));
  let envRT = null;

  const hemi = new THREE.HemisphereLight('#d6e6ff', '#9c927f', 1);
  const sun = new THREE.DirectionalLight('#fff1db', 2.7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(tier.shadowMap, tier.shadowMap);
  Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 300 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(hemi, sun, sun.target);
  const lamp = new THREE.PointLight('#ffc98a', 0, 14, 1.6);   // canopy downlight at night
  scene.add(lamp);

  // ---------- site: lawn, paving, street, parking, trees, lamps ----------
  const site = createSite({ fac, site: bld.site, seed: bld.seed || 12, wallT: T, lampLights: tier.lampShadows, simpleTrees: tierName === 'low' });
  scene.add(site.group);

  // ---------- building ----------
  const mats = {
    wall: new THREE.MeshStandardMaterial({ color: '#efe6da', map: tileTexture(), roughness: 0.82 }),
    base: new THREE.MeshStandardMaterial({ color: '#2a2e33', roughness: 0.55, metalness: 0.35 }),
    band: new THREE.MeshStandardMaterial({ color: '#d6cdbf', roughness: 0.7 }),
    fin: new THREE.MeshStandardMaterial({ color: '#3b4046', roughness: 0.5, metalness: 0.3 }),
    frame: new THREE.MeshStandardMaterial({ color: '#eceeee', roughness: 0.45, metalness: 0.05 }),
    sill: new THREE.MeshStandardMaterial({ color: '#9ca2a8', roughness: 0.4, metalness: 0.6 }),
    rail: new THREE.MeshStandardMaterial({ color: '#c9dde4', roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.32, depthWrite: false }),
    roof: new THREE.MeshStandardMaterial({ color: '#7d8287', roughness: 0.95 }),
    wood: new THREE.MeshStandardMaterial({ color: '#9a6a40', roughness: 0.6 }),
    strip: new THREE.MeshBasicMaterial({ color: '#ffe2b0' }),
    steel: new THREE.MeshStandardMaterial({ color: '#c8ccd0', roughness: 0.3, metalness: 0.85 })
  };
  const parts = Object.fromEntries(Object.keys(mats).map(k => [k, []]));
  // A box on a facade: u (m along the side), y (m), d (m outward from the inner face of the outer wall).
  const fbox = (kind, side, u0, u1, y0, y1, d0, d1) => {
    if (u1 - u0 < 1e-3 || y1 - y0 < 1e-3) return;
    const su = u1 - u0, sy = y1 - y0, sd = d1 - d0, u = (u0 + u1) / 2, d = (d0 + d1) / 2, y = (y0 + y1) / 2;
    let g;
    if (side === 'north' || side === 'south') {
      g = new THREE.BoxGeometry(su, sy, sd);
      g.translate(u - hx, y, side === 'north' ? -hz - d : hz + d);
    } else {
      g = new THREE.BoxGeometry(sd, sy, su);
      g.translate(side === 'west' ? -hx - d : hx + d, y, u - hz);
    }
    parts[kind].push(g);
  };
  // Soft shade strips (softShadows.js) in facade coordinates: a line q0–q1 [u, y, d], fading out along dq.
  const wpt = (side, u, y, d) => side === 'south' ? [u - hx, y, hz + d] : side === 'north' ? [u - hx, y, -hz - d]
    : side === 'west' ? [-hx - d, y, u - hz] : [hx + d, y, u - hz];
  const shade = [];
  const fshade = (side, q0, q1, dq, a) => {
    const p0 = wpt(side, ...q0), e = wpt(side, q0[0] + dq[0], q0[1] + dq[1], q0[2] + dq[2]);
    shade.push({ p0, p1: wpt(side, ...q1), n: [e[0] - p0[0], e[1] - p0[1], e[2] - p0[2]], a });
  };
  const box = (kind, x, y, z, sx, sy, sz) => {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    g.translate(x, y, z);
    parts[kind].push(g);
  };

  // Glass bays (with the entrance doors as one more bay on the ground floor).
  const bays = [...fac.bays, { floor: 1, side: fac.entrance.side, x0: fac.entrance.x0, x1: fac.entrance.x1, sill: 0, h: fac.entrance.h, kind: 'door', aptNo: null }];
  const sideLen = side => (side === 'north' || side === 'south' ? L : W);
  for (let n = 1; n <= fac.floors; n++) {
    const y0 = (n - 1) * level, kind = n === 1 ? 'base' : 'wall';
    for (const side of ['north', 'south', 'west', 'east']) {
      const list = bays.filter(b => b.floor === n && b.side === side).sort((p, q) => p.x0 - q.x0);
      const ns = side === 'north' || side === 'south';
      let at = ns ? -T : 0;
      const end = ns ? sideLen(side) + T : sideLen(side);
      for (const b of list) {
        const u0 = b.x0 * M, u1 = b.x1 * M;
        const s = y0 + SLAB * M + b.sill * M, e = s + b.h * M;
        fbox(kind, side, at, u0, y0, y0 + level, 0, T);
        fbox(kind, side, u0, u1, y0, s, 0, T);
        fbox(kind, side, u0, u1, e, y0 + level, 0, T);
        // Frame: four bars and a mullion on wide windows, at the glass plane.
        const f = 0.05, fd0 = GLASS_D - 0.03, fd1 = GLASS_D + 0.05;
        fbox('frame', side, u0, u1, s, s + f, fd0, fd1);
        fbox('frame', side, u0, u1, e - f, e, fd0, fd1);
        fbox('frame', side, u0, u0 + f, s, e, fd0, fd1);
        fbox('frame', side, u1 - f, u1, s, e, fd0, fd1);
        if (u1 - u0 > 1.3) fbox('frame', side, (u0 + u1) / 2 - f / 2, (u0 + u1) / 2 + f / 2, s, e, fd0, fd1);
        // Shade in the reveal: darkest by the frame, fading out to the face of the wall; the head the darkest.
        const r0 = fd1, rd = T - fd1, o = 0.002;
        fshade(side, [u0 + o, s, r0], [u0 + o, e, r0], [0, 0, rd], 0.3);
        fshade(side, [u1 - o, s, r0], [u1 - o, e, r0], [0, 0, rd], 0.3);
        fshade(side, [u0, e - o, r0], [u1, e - o, r0], [0, 0, rd], 0.45);
        if (b.kind === 'window' && b.sill > 20) fbox('sill', side, u0 - 0.04, u1 + 0.04, s - 0.04, s, GLASS_D, T + 0.06);   // metal sill
        // Living rooms on the long facades: a balcony slab with a glass rail on steel posts and a handrail.
        if (b.kind === 'window' && n > 1 && ns && BALCONY.has(b.purpose)) {
          const a0 = u0 - 0.35, a1 = u1 + 0.35, fl = y0 + SLAB * M, d1 = T + 1.1;
          fbox('band', side, a0, a1, fl - 0.18, fl, T, d1);
          fshade(side, [a0, fl - 0.18, T + 0.002], [a1, fl - 0.18, T + 0.002], [0, -0.3, 0], 0.28);   // under the slab
          fbox('rail', side, a0 + 0.04, a1 - 0.04, fl + 0.1, fl + 1.0, d1 - 0.07, d1 - 0.05);
          fbox('rail', side, a0, a0 + 0.02, fl + 0.1, fl + 1.0, T, d1 - 0.05);
          fbox('rail', side, a1 - 0.02, a1, fl + 0.1, fl + 1.0, T, d1 - 0.05);
          fbox('sill', side, a0, a1, fl + 1.0, fl + 1.05, d1 - 0.09, d1 - 0.03);
          fbox('sill', side, a0, a0 + 0.04, fl + 1.0, fl + 1.05, T, d1 - 0.03);
          fbox('sill', side, a1 - 0.04, a1, fl + 1.0, fl + 1.05, T, d1 - 0.03);
          for (const pu of [a0 + 0.02, a1 - 0.06]) fbox('sill', side, pu, pu + 0.04, fl, fl + 1.0, d1 - 0.1, d1 - 0.06);
        }
        // Shops: a slim canopy over the glass.
        if (b.kind === 'shop') {
          fbox('fin', side, u0 - 0.15, u1 + 0.15, e + 0.12, e + 0.2, T, T + 1.2);
          fbox('sill', side, u0 - 0.15, u1 + 0.15, e + 0.2, e + 0.24, T + 1.15, T + 1.2);
        }
        at = u1;
      }
      fbox(kind, side, at, end, y0, y0 + level, 0, T);
      // Storey band, a slight step out of the wall.
      if (n > 1) fbox('band', side, ns ? -T - 0.05 : 0, ns ? sideLen(side) + T + 0.05 : sideLen(side), y0, y0 + 0.2, T - 0.01, T + 0.05);
    }
    // Stone pilasters between neighbouring apartments on the long facades, from the first storey band up.
    if (n > 1) {
      for (const side of ['north', 'south']) {
        const spans = fac.spans.filter(s => s.floor === n && s.side === side).sort((p, q) => p.x0 - q.x0);
        for (let i = 1; i < spans.length; i++) {
          const u = (spans[i - 1].x1 + spans[i].x0) / 2 * M;
          fbox('wall', side, u - 0.3, u + 0.3, y0 + 0.2, y0 + level, T - 0.01, T + 0.16);
        }
      }
    }
  }
  // Corner pilasters, roof slab, cornice, parapet with a metal cap, lift room.
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) box('wall', sx * (hx + T), (level + top) / 2, sz * (hz + T), 0.7, top - level, 0.7);
  box('roof', 0, top + 0.12, 0, L + 2 * T, 0.24, W + 2 * T);
  const CORN = 0.55;
  for (const side of ['north', 'south', 'west', 'east']) {
    const ns = side === 'north' || side === 'south';
    const c0 = ns ? -T - CORN : -CORN, c1 = ns ? L + T + CORN : W + CORN;
    fbox('band', side, c0, c1, top - 0.1, top + 0.22, T, T + CORN);
    fbox('band', side, c0 + 0.1, c1 - 0.1, top - 0.32, top - 0.1, T, T + CORN * 0.55);
    fshade(side, [ns ? -T : 0, top - 0.32, T + 0.002], [ns ? L + T : W, top - 0.32, T + 0.002], [0, -0.7, 0], 0.32);
    fbox('wall', side, ns ? -T : 0, ns ? L + T : W, top + 0.22, top + PARAPET, 0, T);
    fbox('sill', side, ns ? -T : 0, ns ? L + T : W, top + PARAPET, top + PARAPET + 0.06, -0.03, T + 0.05);
  }
  const core = bld.core;
  if (core) box('fin', (core.x + core.w / 2) * M - hx, top + 1.7, (core.y + core.h / 2) * M - hz, core.w * M, 3.4, core.h * M * 0.7);
  // The entrance reads from afar: a timber portal round the doors under a deep canopy with a lit
  // "ENTRANCE 1" fascia, wall lights on the portal, long door handles, a projecting blade sign.
  const ent = fac.entrance, eu = (ent.x0 + ent.x1) / 2 * M, cw = 6.4, cd = 2.6, cy = level - 0.15;
  const du0 = ent.x0 * M, du1 = ent.x1 * M, dTop = SLAB * M + ent.h * M;
  fbox('wood', ent.side, du0 - 0.75, du0 - 0.08, 0, cy, T, T + 0.32);            // portal pillars
  fbox('wood', ent.side, du1 + 0.08, du1 + 0.75, 0, cy, T, T + 0.32);
  fbox('wood', ent.side, du0 - 0.08, du1 + 0.08, dTop + 0.05, cy, T, T + 0.32);   // lintel
  fbox('wood', ent.side, eu - cw / 2, eu + cw / 2, cy, cy + 0.16, T, T + cd);       // canopy slab
  fbox('fin', ent.side, eu - cw / 2 - 0.04, eu + cw / 2 + 0.04, cy - 0.06, cy, T, T + cd + 0.04);
  fbox('fin', ent.side, eu - cw / 2 - 0.04, eu + cw / 2 + 0.04, cy - 0.34, cy + 0.2, T + cd, T + cd + 0.07);   // fascia
  fbox('strip', ent.side, eu - cw / 2 + 0.3, eu + cw / 2 - 0.3, cy - 0.08, cy - 0.06, T + cd - 0.25, T + cd - 0.18);
  // Door handles: two long bars by the meeting stiles.
  for (const k of [-1, 1]) fbox('steel', ent.side, eu + k * 0.09 - 0.02, eu + k * 0.09 + 0.02, 0.85, 1.95, GLASS_D + 0.06, GLASS_D + 0.1);
  // Wall lights on the pillars, at eye height.
  for (const u of [du0 - 0.42, du1 + 0.42]) fbox('strip', ent.side, u - 0.09, u + 0.09, 2.0, 2.32, T + 0.32, T + 0.42);
  lamp.position.set(eu - hx, cy - 0.5, ent.side === 'south' ? hz + T + cd / 2 : -hz - T - cd / 2);

  const building = new THREE.Group();
  for (const [kind, list] of Object.entries(parts)) {
    if (!list.length) continue;
    const geo = mergeGeometries(list);
    for (const g of list) g.dispose();
    const uv = { wall: PHOTO_UV.wall, base: PHOTO_UV.base, band: PHOTO_UV.concrete, roof: PHOTO_UV.concrete, wood: PHOTO_UV.wood }[kind];
    if (uv) worldUV(geo, ...uv);
    const mesh = new THREE.Mesh(geo, mats[kind]);
    mesh.castShadow = kind !== 'strip' && kind !== 'rail';
    mesh.receiveShadow = kind !== 'strip';
    building.add(mesh);
  }
  const shadeMesh = shadeStrips(shade, 'facadeShade');
  if (shadeMesh) building.add(shadeMesh);
  scene.add(building);
  // Photo stone, concrete and timber (the library facade sets when on disk, else the bundled sets), once decoded;
  // the procedural look until then (and on obviously weak devices). Called again after the facade sets are downloaded.
  const refreshPhoto = () => applyPhotoFacade({ mats, site: site.mats, trees: site.setTreePhoto, small: tierName === 'low',
    anisotropy: Math.min(tier.anisotropy * 2, renderer.capabilities.getMaxAnisotropy()) })
    .then(ok => { if (ok) { shadows = true; dirty = true; } return ok; });
  if (photoAuto()) refreshPhoto();

  // Signs: "ENTRANCE 1" glowing on the canopy fascia, the same on a blade sign beside the doors (seen from
  // along the facade), the residence name in big letters on the roof parapet over the entrance.
  const front = (d, y, u) => ent.side === 'south' ? [u - hx, y, hz + d] : [u - hx, y, -hz - d];
  const signPlane = (w, h, mat, d, y, u, rot = 0) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    m.position.set(...front(d, y, u));
    m.rotation.y = (ent.side === 'north' ? Math.PI : 0) + rot;
    scene.add(m);
    return m;
  };
  const textMat = () => {
    const t = new THREE.CanvasTexture(document.createElement('canvas'));
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return new THREE.MeshBasicMaterial({ map: t, transparent: true, side: THREE.DoubleSide, toneMapped: false });
  };
  const doorMat = textMat(), bladeMat = textMat(), nameMat = textMat();
  signPlane(3.6, 0.4, doorMat, T + cd + 0.075, cy - 0.07, eu);
  const bladeU = du0 - 0.42;
  const bladeBox = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.86, 0.66), mats.fin);
  bladeBox.position.set(...front(T + 0.32 + 0.4, 1.9, bladeU));
  scene.add(bladeBox);
  for (const k of [-1, 1]) signPlane(0.6, 0.8, bladeMat, T + 0.32 + 0.4, 1.9, bladeU + k * 0.045, k * Math.PI / 2);
  const nameW = Math.min(18, L * 0.6);
  const nameU = Math.max(nameW / 2 + 1, Math.min(L - nameW / 2 - 1, eu));
  signPlane(nameW, 0.95, nameMat, T + 0.02, top + PARAPET / 2 + 0.02, nameU);

  function draw(mat, w, h, paint) {
    const c = mat.map.image;
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.clearRect(0, 0, w, h);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    paint(g);
    mat.map.needsUpdate = true;
  }
  function setTitle(text, entrance = entranceText) {
    entranceText = entrance;
    draw(nameMat, 2048, 108, g => {
      g.fillStyle = '#ffffff';
      g.font = '700 84px system-ui, sans-serif';
      g.fillText(text.toUpperCase(), 1024, 58, 2000);
    });
    draw(doorMat, 1024, 114, g => {
      g.fillStyle = '#ffffff';
      g.font = '700 78px system-ui, sans-serif';
      g.fillText(entrance, 512, 60, 1000);
    });
    const [word, no] = splitNo(entrance);
    draw(bladeMat, 384, 512, g => {
      g.fillStyle = '#f6f1e7';
      g.beginPath();
      g.roundRect(8, 8, 368, 496, 36);
      g.fill();
      g.fillStyle = '#2e3236';
      g.font = '800 270px system-ui, sans-serif';
      g.fillText(no, 192, 220);
      g.font = '700 50px system-ui, sans-serif';
      g.fillText(word, 192, 430, 340);
    });
    dirty = true;
  }

  // ---------- glass: one instanced quad per bay with a room behind it (windows.js) ----------
  const KIND = { window: 0, shop: 1, lobby: 2, door: 2 };
  const q = new THREE.Quaternion(), yAxis = new THREE.Vector3(0, 1, 0);
  const ROT = { south: 0, north: Math.PI, east: Math.PI / 2, west: -Math.PI / 2 };
  const mtx = bays.map(b => {
    const u = (b.x0 + b.x1) / 2 * M, su = (b.x1 - b.x0) * M, sy = b.h * M;
    const y = (b.floor - 1) * level + SLAB * M + b.sill * M + sy / 2;
    const pos = b.side === 'north' || b.side === 'south'
      ? new THREE.Vector3(u - hx, y, b.side === 'north' ? -hz - GLASS_D : hz + GLASS_D)
      : new THREE.Vector3(b.side === 'west' ? -hx - GLASS_D : hx + GLASS_D, y, u - hz);
    return new THREE.Matrix4().compose(pos, q.setFromAxisAngle(yAxis, ROT[b.side]), new THREE.Vector3(su, sy, 1));
  });
  const windows = createWindows(bays, skyMat.uniforms, { simple: tierName === 'low' });
  scene.add(windows.mesh);
  // Stable "someone is home" choice per bay for the evening and night.
  const chance = bays.map((b, i) => ((Math.sin(i * 12.9898 + (b.aptNo || 0) * 78.233) * 43758.5453) % 1 + 1) % 1);

  // ---------- current floor, picking boxes ----------
  const pad = T + 0.25;
  const floorBoxes = [];
  for (let n = 1; n <= fac.floors; n++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(L + 2 * pad, level, W + 2 * pad));
    m.position.y = (n - 1) * level + level / 2;
    m.visible = false;
    m.userData.floor = n;
    m.updateMatrixWorld();
    floorBoxes.push(m);
  }
  const hiGeo = new THREE.BoxGeometry(L + 2 * pad, level, W + 2 * pad);
  const hi = new THREE.Group();
  hi.add(new THREE.LineSegments(new THREE.EdgesGeometry(hiGeo), new THREE.LineBasicMaterial({ color: '#4dabf7' })),
    new THREE.Mesh(hiGeo, new THREE.MeshBasicMaterial({ color: '#4dabf7', transparent: true, opacity: 0.1, depthWrite: false })));
  scene.add(hi);

  // ---------- camera and controls ----------
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, top * 0.4, 0);
  camera.position.set(52, top * 0.62, 84);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 32;
  controls.maxDistance = 190;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.autoRotateSpeed = 0.55;
  controls.enablePan = false;

  // ---------- state ----------
  let time = 'day', style = { colorOf: () => null, dim: () => false, hover: null };
  let cur = mixTimes(TIMES.day, TIMES.day, 0), tween = null;   // the levels on screen, the change under way
  let dirty = true, shadows = true, paused = false, visible = true, onScreen = true;
  let auto = true, pointerIn = false, lastTouch = -1e9, fly = null, orbitAcc = 0;
  const clock = new THREE.Clock();

  // Day / evening / night: blends over TWEEN_SEC like the rooms' light; the first call (and `instant`) jumps.
  function setTime(name, instant = false) {
    time = name in TIMES ? name : 'day';
    if (instant) { tween = null; applyTime(mixTimes(TIMES[time], TIMES[time], 0), true); return; }
    tween = { from: cur, to: TIMES[time], t: 0, env: 0 };
    dirty = true;
  }

  function stepTime(dt) {
    if (!tween) return;
    tween.t = Math.min(1, tween.t + dt / TWEEN_SEC);
    // The reflections follow the sky in steps (a re-render each ~1/8 of the way), not in one jump at the end.
    const env = tween.t >= 1 || tween.t - tween.env >= 0.12;
    if (env) tween.env = tween.t;
    applyTime(mixTimes(tween.from, tween.to, easeInOut(tween.t)), env);
    if (tween.t >= 1) tween = null;
  }

  // env: also re-render the reflections of the sky (not on every frame of the blend).
  function applyTime(p, env) {
    cur = p;
    const on = Math.min(1, p.lamp / LAMPS_ON);
    skyMat.uniforms.top.value.set(p.top);
    skyMat.uniforms.mid.value.set(p.mid);
    skyMat.uniforms.bottom.value.set(p.bottom);
    scene.fog.color.set(p.fog);
    hemi.color.set(p.sky);
    hemi.groundColor.set(p.ground);
    hemi.intensity = p.hemi;
    sun.color.set(p.sun);
    sun.intensity = p.sunI;
    const el = THREE.MathUtils.degToRad(p.elev), az = THREE.MathUtils.degToRad(p.azim);
    sun.position.set(Math.sin(az) * Math.cos(el) * 120, Math.sin(el) * 120, Math.cos(az) * Math.cos(el) * 120);
    renderer.toneMappingExposure = p.exposure;
    lamp.intensity = p.lamp * 30;
    windows.setTime({ day: Math.min(1, p.hemi / 0.72), lamp: 1.1 });
    mats.strip.color.set('#d9d2c4').lerp(tmpC.set('#ffd9a0'), on);
    nameMat.color.set('#2c3036').lerp(tmpC.set('#ffe7c2'), on);     // dark letters by day, lit at dusk and night
    doorMat.color.set('#ffffff').lerp(tmpC.set('#fff1d6'), on);
    site.setTime(p);
    if (env) {
      envRT?.dispose();
      envRT = pmrem.fromScene(envScene, 0, 1, 1000);
      scene.environment = envRT.texture;
    }
    scene.environmentIntensity = Math.max(0.25, p.hemi);
    paint(style);
    shadows = dirty = true;
  }

  const tmpC = new THREE.Color(), hsl = {};
  const tintOf = css => {
    const c = new THREE.Color(css);
    c.getHSL(hsl);
    return c.setHSL(hsl.h, Math.min(1, hsl.s * 1.1 + 0.15), 0.5);
  };
  function paint(next = style) {
    style = { ...style, ...next };
    const p = cur;     // windows light up one by one as the evening comes
    bays.forEach((b, i) => {
      const css = b.aptNo ? style.colorOf(b.aptNo) : null;
      const dim = b.aptNo ? style.dim(b.aptNo) : false;
      const hov = b.aptNo && b.aptNo === style.hover;
      // Lit at night: chosen apartments (not dimmed) and some neighbours; shops and lobby always.
      const on = p.lit > 0 && (b.kind !== 'window' ? true : !dim && (css ? chance[i] < p.lit + 0.25 : chance[i] < p.lit));
      const flat = b.kind === 'window';
      windows.set(i, {
        matrix: mtx[i], seed: chance[i], sill: flat ? b.sill * M : 0, kind: KIND[b.kind] ?? 0,
        // Flats: on or off; shops and the lobby are lit by day too, brighter in the evening.
        lit: flat ? (on ? 1 : 0) : 0.35 + 0.65 * Math.min(1, p.lamp / LAMPS_ON),
        tint: css ? tintOf(css) : null, tintK: 0.18, dim, hover: hov
      });
    });
    windows.commit();
    dirty = true;
  }

  function setFloor(n) {
    hi.position.y = (n - 1) * level + level / 2;
    hi.visible = n >= 1 && n <= fac.floors;
    dirty = true;
  }

  function flyToFloor(n) {
    const y = (n - 1) * level + level / 2;
    const dir = camera.position.clone().sub(controls.target);
    dir.y = 0;
    dir.setLength(48);
    fly = { t: 0, fromT: controls.target.clone(), toT: new THREE.Vector3(0, y, 0),
      fromP: camera.position.clone(), toP: new THREE.Vector3(dir.x, y + 4, dir.z) };
    lastTouch = performance.now();
  }

  // ---------- picking ----------
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function pick(e) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hitG = ray.intersectObjects([windows.mesh, building], false)[0];
    if (hitG && hitG.object !== building && hitG.instanceId != null) {
      const b = bays[hitG.instanceId];
      return { aptNo: b.aptNo, floor: b.floor };
    }
    const hitF = ray.intersectObjects(floorBoxes, false)[0];
    if (!hitF || (hitG && hitG.distance < hitF.distance - 1)) return hitG ? { aptNo: null, floor: floorFromY(hitG.point.y) } : null;
    return { aptNo: null, floor: hitF.object.userData.floor };
  }
  const floorFromY = y => Math.min(fac.floors, Math.max(1, Math.floor(y / level) + 1));

  const cv = renderer.domElement;
  cv.addEventListener('pointerenter', () => { pointerIn = true; });
  cv.addEventListener('pointerleave', () => { pointerIn = false; onHover(null); });
  let down = null, hoverFrame = 0;
  cv.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; lastTouch = performance.now(); });
  cv.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse' || hoverFrame || walker.active) return;
    hoverFrame = requestAnimationFrame(() => {
      hoverFrame = 0;
      const h = pick(e);
      cv.style.cursor = h?.aptNo ? 'pointer' : h ? 'zoom-in' : 'grab';
      onHover(h?.aptNo ?? null, e);
    });
  });
  cv.addEventListener('click', e => {
    if (walker.active) return;
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
    const h = pick(e);
    if (!h) return;
    if (h.floor) onFloor(h.floor);
    if (h.aptNo) onPick(h.aptNo);
  });
  cv.addEventListener('dblclick', e => {
    if (walker.active) return;
    const h = pick(e);
    if (h?.floor) flyToFloor(h.floor);
  });
  controls.addEventListener('start', () => { lastTouch = performance.now(); fly = null; });

  // ---------- walking on the site ----------
  const walker = createStreetWalk({ camera, dom: renderer.domElement, walk: site.walk, obstacles: site.obstacles,
    onDoor: () => onDoor?.(), onStop: () => endWalk(true) });
  // Where the entrance is from the walker: distance (m) and the turn to it (rad, + to the right), sent when it
  // changes noticeably.
  const fwd = new THREE.Vector3();
  let lastCue = '';
  function cue() {
    if (!onCue) return;
    const d = site.walk.door, tx = (d.x0 + d.x1) / 2 - camera.position.x, tz = d.z - camera.position.z;
    camera.getWorldDirection(fwd);
    const angle = Math.atan2(fwd.x * tz - fwd.z * tx, fwd.x * tx + fwd.z * tz);
    const dist = Math.hypot(tx, tz);
    const key = Math.round(dist) + ':' + Math.round(angle / 0.2);
    if (key === lastCue) return;
    lastCue = key;
    onCue({ dist, angle });
  }
  function startWalk(at = 'street') {
    fly = null;
    controls.enabled = false;
    controls.autoRotate = false;
    walker.start(at);
    lastCue = '';
    cue();
    onHover(null);
    cv.style.cursor = 'crosshair';
    dirty = true;
    onWalk?.(true);
  }
  function endWalk(fromKey = false) {
    if (!walker.active && !fromKey) return;
    walker.stop();
    onCue?.(null);
    controls.enabled = true;
    lastTouch = performance.now();
    cv.style.cursor = '';
    dirty = true;
    onWalk?.(false);
  }
  controls.addEventListener('change', () => { dirty = true; });

  // ---------- loop: draws only on change; the auto-orbit draws every frame while it turns ----------
  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    dirty = true;
  }
  new ResizeObserver(resize).observe(container);
  document.addEventListener('visibilitychange', () => { visible = !document.hidden; });
  new IntersectionObserver(([en]) => { onScreen = en.isIntersecting; }).observe(container);

  function frame() {
    requestAnimationFrame(frame);
    let dt = Math.min(clock.getDelta(), 0.1);
    if (paused || !visible || !onScreen) return;
    stepTime(dt);
    if (walker.active) {
      if (walker.update(dt)) { dirty = true; cue(); }
      if (!dirty) return;
      dirty = false;
      if (shadows) { renderer.shadowMap.needsUpdate = true; shadows = false; }
      renderer.render(scene, camera);
      return;
    }
    controls.autoRotate = auto && !pointerIn && !fly && performance.now() - lastTouch > 8000;
    // The slow orbit alone does not need the screen's full rate: 40 frames a second.
    if (controls.autoRotate && !fly && !dirty) {
      orbitAcc += dt;
      if (orbitAcc < 1 / 40) return;
      dt = orbitAcc;
    }
    orbitAcc = 0;
    if (fly) {
      fly.t = Math.min(1, fly.t + dt / 1.1);
      const k = fly.t < 0.5 ? 2 * fly.t * fly.t : 1 - (-2 * fly.t + 2) ** 2 / 2;
      controls.target.lerpVectors(fly.fromT, fly.toT, k);
      camera.position.lerpVectors(fly.fromP, fly.toP, k);
      if (fly.t >= 1) fly = null;
      dirty = true;
    }
    if (controls.update(dt)) dirty = true;
    if (!dirty) return;
    dirty = false;
    if (shadows) { renderer.shadowMap.needsUpdate = true; shadows = false; }
    renderer.render(scene, camera);
  }

  setTitle(title);
  setTime('day', true);
  setFloor(0);
  resize();
  frame();

  return {
    paint, setFloor, setTime, setTitle, flyToFloor, startWalk, endWalk,
    isWalking: () => walker.active, walkPad: walker.pad,
    getTime: () => time,
    setAuto(on) { auto = on; if (on) lastTouch = -1e9; dirty = true; },
    getAuto: () => auto,
    pause(on) { paused = on; holdPhotos(on); dirty = true; clock.getDelta(); },
    requestRender() { dirty = true; },
    refreshPhoto,
    renderer, scene, camera, site
  };
}
