// Lighting in 3D: env reflections, ceiling fixture, sun. Levels come from lighting.js and move smoothly
// (tweenLights) instead of rebuilding the lights on every change.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { getMats, furnitureMat } from './textures3d.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { lightingOf, targetsFor, easeInOut, TWEEN_SEC, fixturesSpec, defaultFixtures, shadowSlots } from '../lighting.js';
import { patchSpotClip } from './spotClip.js';

patchSpotClip();   // spots light only their own room (before any shader is compiled)

export { SCENES, CEILINGS, DEFAULT_LIGHTING, lightingOf } from '../lighting.js';

let envTexture = null;

// One-time: image-based lighting for soft reflections on wood/metal.
export function setupEnvironment(renderer, scene) {
  if (envTexture) return;
  const pmrem = new THREE.PMREMGenerator(renderer);
  envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.environment = envTexture;
  scene.environmentIntensity = 0.35;
  RectAreaLightUniformsLib.init();
}

// Shadow quality of the device tier (perf.js): sun map size; `lamps` — how many lamps of the main room cast one.
const shadowCfg = { sun: 2048, lamps: 2 };
export function setShadowQuality({ shadowMap, lampShadows }) {
  shadowCfg.sun = shadowMap;
  shadowCfg.lamps = Number(lampShadows) || 0;
}

function shadowed(light, size, far) {
  light.castShadow = true;
  light.shadow.mapSize.set(size, size);
  light.shadow.bias = -0.002;
  light.shadow.radius = 4;
  light.shadow.camera.near = 0.1;
  light.shadow.camera.far = far;
  return light;
}

// Ceiling lights carry their full power; the current level multiplies it.
function ceilLight(light, power) {
  light.userData.ceilPower = power;
  return light;
}

// The light sources of the fixture (fixtureSpec in lighting.js: positions, cones, power, cut-off distance).
// Every room gets the same lights whether the camera is in it or not, so picking a room does not change its look.
// Shadows by the tier's budget: in the room with the camera its brightest lamps (up to shadowCfg.lamps) at full
// size, in the others the brightest one small, so the light does not shine through the partition.
function addSpec(g, spec, main) {
  const shadow = shadowCfg.lamps ? (main ? 1024 : 512) : 0;
  const cast = new Set(shadow ? shadowSlots(spec.lights, main ? shadowCfg.lamps : 1) : []);
  spec.lights.forEach((l, i) => {
    let light;
    if (l.type === 'point') light = new THREE.PointLight('#ffe2b8', 0, l.distance, 2);
    else if (l.type === 'spot') {
      light = new THREE.SpotLight('#ffe7c4', 0, l.distance, l.angle, l.penumbra, 2);
      light.target.position.set(l.x, 0, l.z);
      light.userData.clip = l.clip;
      g.add(light.target);
    } else {
      light = new THREE.RectAreaLight('#fff1dc', 0, l.w, l.d);
      light.position.set(l.x, l.y, l.z);
      light.lookAt(l.x, 0, l.z);
    }
    light.position.set(l.x, l.y, l.z);
    if (cast.has(i)) shadowed(light, shadow, l.distance || 10);
    g.add(ceilLight(light, l.power));
  });
}

// Luxe chandeliers by the room's furniture collection (the same light source, other fixture geometry):
// couture — a cascade of crystal drops under a brass ring, deco — a brass ring of opal tubes,
// milano — an opal globe on a slim rod, organic — a linen drum.
let glass = null, linenShade = null, bulbMat = null, haloMat = null;
const crystal = () => glass ??= new THREE.MeshStandardMaterial({ color: '#fff6e6', emissive: '#ffe2b0', emissiveIntensity: 0.6,
  roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.72 });

function stem(g, cx, cz, H, len, mat, r = 0.006) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10), mat);
  m.position.set(cx, H - len / 2, cz);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.02, 24), mat);
  cap.position.set(cx, H - 0.01, cz);
  g.add(m, cap);
}

const LUXE_FIXTURE = {
  couture(g, cx, cz, H) {
    const brass = furnitureMat('brushedBrass', '', 'ok'), y = H - 0.5;
    stem(g, cx, cz, H, 0.42, brass);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.012, 10, 48), brass);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(cx, y, cz);
    g.add(ring);
    // Three tiers of drops on strings, longer towards the middle.
    const drops = [];
    for (const [r, n, len] of [[0.28, 22, 0.22], [0.19, 16, 0.32], [0.1, 10, 0.42]]) {
      for (let i = 0; i < n; i++) {
        const a = i / n * Math.PI * 2 + r * 7;
        for (let k = 0; k < 3; k++) {
          const d = new THREE.OctahedronGeometry(0.018 - k * 0.003);
          d.scale(1, 1.8, 1);
          d.translate(cx + Math.cos(a) * r, y - len * (k + 1) / 3, cz + Math.sin(a) * r);
          drops.push(d);
        }
      }
    }
    g.add(new THREE.Mesh(mergeGeometries(drops), crystal()));
  },
  deco(g, cx, cz, H) {
    const brass = furnitureMat('brushedBrass', '', 'ok'), y = H - 0.42;
    stem(g, cx, cz, H, 0.36, brass);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.016, 10, 56), brass);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(cx, y, cz);
    g.add(ring);
    const tubes = [];
    for (let i = 0; i < 12; i++) {
      const a = i / 12 * Math.PI * 2, t = new THREE.CylinderGeometry(0.022, 0.022, 0.22, 14);
      t.translate(cx + Math.cos(a) * 0.32, y - 0.12, cz + Math.sin(a) * 0.32);
      tubes.push(t);
      const arm = new THREE.CylinderGeometry(0.004, 0.004, 0.32, 6);
      arm.rotateZ(Math.PI / 2); arm.rotateY(-a);
      arm.translate(cx + Math.cos(a) * 0.16, y + 0.02, cz + Math.sin(a) * 0.16);
      g.add(new THREE.Mesh(arm, brass));
    }
    g.add(new THREE.Mesh(mergeGeometries(tubes), getMats().lampShade));
  },
  milano(g, cx, cz, H) {
    const bronze = furnitureMat('bronze', '', 'ok');
    stem(g, cx, cz, H, 0.55, bronze, 0.004);
    const globe = new THREE.Mesh(new THREE.SphereGeometry(0.17, 32, 20), getMats().lampShade);
    globe.position.set(cx, H - 0.72, cz);
    g.add(globe);
  },
  organic(g, cx, cz, H) {
    const bronze = furnitureMat('bronze', '', 'ok'), y = H - 0.6;
    stem(g, cx, cz, H, 0.5, bronze, 0.003);
    const shadeMat = linenShade ??= Object.assign(furnitureMat('linen', '#efe6d6', 'ok').clone(),
      { side: THREE.DoubleSide, emissive: new THREE.Color('#ffd9a0'), emissiveIntensity: 0.45 });
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.26, 40, 1, true), shadeMat);
    drum.position.set(cx, y, cz);
    const diffuser = new THREE.Mesh(new THREE.CircleGeometry(0.29, 32), getMats().lampShade);
    diffuser.rotation.x = Math.PI / 2;
    diffuser.position.set(cx, y - 0.12, cz);
    g.add(drum, diffuser);
  }
};

// A bulb inside a shade: grey glass when off, warm white when the ceiling lights are on, with a small soft
// halo (no bloom: a faint additive sprite a little larger than the bulb).
function haloTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d'), grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,236,200,1)'); grad.addColorStop(0.35, 'rgba(255,226,180,.45)'); grad.addColorStop(1, 'rgba(255,220,170,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const BULB = new THREE.SphereGeometry(0.022, 14, 10);
function bulb(g, x, y, z, halo = 0.2) {
  bulbMat ??= new THREE.MeshStandardMaterial({ color: '#d9d5cc', emissive: '#fff1d2', emissiveIntensity: 0, roughness: 0.2 });
  haloMat ??= new THREE.SpriteMaterial({ map: haloTexture(), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  const b = new THREE.Mesh(BULB, bulbMat);
  b.position.set(x, y, z);
  const s = new THREE.Sprite(haloMat);
  s.scale.set(halo, halo, 1);
  s.position.set(x, y, z);
  s.raycast = () => {};       // not picked as the fixture
  g.add(b, s);
}

// Chandelier at (cx, cz): stem, hub, five arms with glowing shades (luxe collections: their own fixture).
function chandelier(g, cx, cz, H, look) {
  if (LUXE_FIXTURE[look]) return LUXE_FIXTURE[look](g, cx, cz, H);
  const M = getMats(), y = H - 0.45;
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.4), M.metal);
  stem.position.set(cx, H - 0.2, cz);
  const hub = new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 12), M.metal);
  hub.position.set(cx, y, cz);
  g.add(stem, hub);
  for (let i = 0; i < 5; i++) {
    const a = i / 5 * Math.PI * 2, r = 0.24;
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, r), M.metal);
    arm.rotation.z = Math.PI / 2;
    arm.rotation.y = -a;
    arm.position.set(cx + Math.cos(a) * r / 2, y, cz + Math.sin(a) * r / 2);
    const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.07, 0.1, 16, 1, true), M.lampShade);
    shade.position.set(cx + Math.cos(a) * r, y + 0.05, cz + Math.sin(a) * r);
    g.add(arm, shade);
    bulb(g, cx + Math.cos(a) * r, y + 0.03, cz + Math.sin(a) * r);
  }
}

// Pendant: one shade on a long cord, a little lower than a chandelier (over a table, a counter).
function pendant(g, cx, cz, H, look) {
  const luxe = look === 'couture' || look === 'deco';
  const metal = luxe ? furnitureMat('brushedBrass', '', 'ok') : look === 'milano' || look === 'organic' ? furnitureMat('bronze', '', 'ok') : getMats().metal;
  stem(g, cx, cz, H, 0.6, metal, 0.003);
  const y = H - 0.7;
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.17, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2), metal);
  dome.position.set(cx, y, cz);
  const inner = new THREE.Mesh(new THREE.CircleGeometry(0.165, 32), getMats().lampShade);
  inner.rotation.x = Math.PI / 2;
  inner.position.set(cx, y + 0.002, cz);
  g.add(dome, inner);
  bulb(g, cx, y - 0.01, cz, 0.3);
}

// A recessed spot: a flush housing in the ceiling.
const SPOT_DISC = new THREE.CylinderGeometry(0.05, 0.05, 0.01, 20);
function spot(g, cx, cz, H) {
  const m = new THREE.Mesh(SPOT_DISC, getMats().lampShade);
  m.position.set(cx, H - 0.005, cz);
  g.add(m);
}

// LED panel: an area light (no shadows) + a glowing flat box of the light's size.
function panel(g, cx, cz, H, l) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(l?.w || 0.6, 0.02, l?.d || 0.6), getMats().lampShade);
  m.position.set(cx, H - 0.01, cz);
  g.add(m);
}

// The fixtures of a room at their places (cm of the room): one group per fixture (userData.fixtureId, picked in 3D),
// then the light sources of all of them. merged: the spots as one wide down-light (the lamp budget is spent).
function buildFixtures(g, fixtures, L, W, H, main, merged, look) {
  const spec = fixturesSpec(fixtures, L, W, H, { merged });
  for (const f of fixtures) {
    const fg = new THREE.Group(), x = f.x / 100, z = f.y / 100;
    fg.name = 'fixture';
    fg.userData.fixtureId = f.id;
    if (f.kind === 'chandelier') chandelier(fg, x, z, H, look);
    else if (f.kind === 'pendant') pendant(fg, x, z, H, look);
    else if (f.kind === 'spot') spot(fg, x, z, H);
    else if (f.kind === 'panel') panel(fg, x, z, H, spec.lights.find(l => l.fixture === f.id));
    g.add(fg);
  }
  addSpec(g, spec, main);
}

/** Real light sources of a room's fixtures (the lamp budget counts them). */
export const lampCount = (fixtures, { L, W, H }) => fixturesSpec(fixtures, L, W, H).lights.length;

/**
 * Lights of a room: built when the room, its window or the fixture type change; levels are tweened.
 * @param size { L, W, H } in metres; win — first window { cx, cz, nx, nz } (centre, outward normal) or null
 * @param prev — levels of the replaced lights group: the new one continues from them, its fixture fades in.
 * group.userData.cur.env — environment intensity for the scene.
 * main — the room with the camera: sky light, sun and full-size shadows; the other rooms get the same fixture.
 * merged — spots as one wide down-light (the lamp budget is spent).
 * look — the room's furniture collection: luxe ones get their own chandelier.
 * fixtures — the room's ceiling lights (cm, lighting.js); default: the layout of the ceiling type.
 * fade — the new fixture fades in (a new type); a moved or added light keeps the level.
 */
export function buildLights({ L, W, H }, win, lighting, prev = null, main = true, merged = false, look = 'modern',
  { fixtures = defaultFixtures(lightingOf(lighting).ceiling, L * 100, W * 100), fade = true } = {}) {
  const group = new THREE.Group();
  group.name = 'lights';

  // Ambient: warm floor bounce + cool sky.
  const hemi = main ? new THREE.HemisphereLight('#f4f6ff', '#8a7660', 0) : null;
  if (hemi) group.add(hemi);
  buildFixtures(group, fixtures, L, W, H, main, merged, look);

  // Sun from outside through the first window (north by default); it sinks and turns warm towards the evening.
  const sun = new THREE.DirectionalLight('#ffffff', 0);
  sun.castShadow = main;
  sun.shadow.mapSize.set(shadowCfg.sun, shadowCfg.sun);
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.02;
  const ext = Math.max(L, W) * 1.2;
  Object.assign(sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 0.5, far: 20 });
  const w = win || { cx: L / 2, cz: 0, nx: 0, nz: -1 };
  const depth = w.nz ? W : L;
  sun.target.position.set(w.cx - w.nx * depth * 0.6, 0, w.cz - w.nz * depth * 0.6);
  if (main) group.add(sun, sun.target);

  const ceil = [];
  group.traverse(o => { if (o.isLight && o.userData.ceilPower) ceil.push(o); });
  const place = h => {
    const out = 5 - 1.5 * Math.min(1, Math.max(0, (h - 0.6) / 1.9));    // low sun shines deeper into the room
    sun.position.set(w.cx + w.nx * out + w.nz * 1.5, H + h, w.cz + w.nz * out - w.nx * 1.5);
  };
  const to = targetsFor(lighting);
  group.userData = { hemi, sun, ceil, place, sunScale: win ? 1 : 0.55, to, from: null, t: 1,
    cur: prev ? { ...prev, ceil: fade ? 0 : prev.ceil } : { ...to } };
  applyLevels(group);
  if (prev) setLightTargets(group, lighting, true);
  return group;
}

const COLORS = ['sky', 'sunColor'];
const ca = new THREE.Color(), cb = new THREE.Color();

// New target levels (scene, 💡); the tween starts from the current ones.
export function setLightTargets(group, lighting, force = false) {
  const u = group.userData, to = targetsFor(lighting);
  if (!force && JSON.stringify(to) === JSON.stringify(u.to)) return;
  u.from = { ...u.cur };
  u.to = to;
  u.t = 0;
}

/** Advance the tween by dt seconds; true while the levels are changing (the caller updates env and fixtures). */
export function tweenLights(group, dt) {
  const u = group.userData;
  if (u.t >= 1) return false;
  u.t = Math.min(1, u.t + dt / TWEEN_SEC);
  const k = easeInOut(u.t);
  for (const key of Object.keys(u.to)) {
    u.cur[key] = COLORS.includes(key)
      ? '#' + ca.set(u.from[key]).lerp(cb.set(u.to[key]), k).getHexString()
      : u.from[key] + (u.to[key] - u.from[key]) * k;
  }
  applyLevels(group);
  return true;
}

function applyLevels(group) {
  const u = group.userData, c = u.cur, M = getMats();
  if (u.hemi) u.hemi.intensity = c.hemi + (c.bounce || 0);
  M.sky.color.set(c.sky);
  M.lampShade.emissiveIntensity = c.shade;
  // Crystal drops and linen drums glow only while the ceiling lights are on.
  if (glass) glass.emissiveIntensity = 0.6 * c.ceil;
  if (linenShade) linenShade.emissiveIntensity = 0.45 * c.ceil;
  if (bulbMat) bulbMat.emissiveIntensity = 2.2 * c.ceil;
  if (haloMat) haloMat.opacity = 0.35 * c.ceil;
  u.sun.color.set(c.sunColor);
  u.sun.intensity = c.sunPower * u.sunScale;
  u.place(c.sunHeight);
  for (const l of u.ceil) l.intensity = l.userData.ceilPower * c.ceil;
}

// Floor lamps and sconces carry their own light (userData.lampPower); level = lights.userData.cur.fix.
// Glowing parts (lamp shades, light strips) carry their full glow in material.userData.glow.
export function applyFixtures(furniture, level) {
  furniture.traverse(o => {
    if (o.isLight && o.userData.lampPower) o.intensity = o.userData.lampPower * level;
    else if (o.material?.userData?.glow) o.material.emissiveIntensity = o.material.userData.glow * level;
  });
}
