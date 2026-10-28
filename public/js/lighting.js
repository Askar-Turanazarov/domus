// Room lighting settings (pure: used by the 3D scene, storage and tests).
// lighting = { scene: 'day'|'evening'|'night', ceiling: 'chandelier'|'spots'|'panel'|'none', lampsOn?: boolean }
// lampsOn: the 💡 switch; absent / null = the scene decides (day off, evening and night on).
export const SCENES = ['day', 'evening', 'night'];
export const CEILINGS = ['chandelier', 'spots', 'panel', 'none'];
export const DEFAULT_LIGHTING = { scene: 'day', ceiling: 'chandelier' };
export const TWEEN_SEC = 1.2;
// Sky light plus the lamps' bounce reaches at least this with the lamps on (night is dark only outside).
export const BOUNCE = 0.85;

// Per scene: ambient, reflections, sky colour behind the window, sun (height in m above the ceiling; < 0 = set), lamps.
export const PRESETS = {
  day:     { hemi: 0.9,  env: 0.3,  sky: '#bfe3ff', sun: { color: '#fff4e0', power: 2.2, height: 2.5 }, lamps: false },
  evening: { hemi: 0.45, env: 0.15, sky: '#f0a46e', sun: { color: '#ff9a4d', power: 1.3, height: 0.6 }, lamps: true },   // ≈ 2700 K, low sun
  night:   { hemi: 0.12, env: 0.05, sky: '#0b1426', sun: { color: '#3d4a6b', power: 0, height: -1.5 }, lamps: true }
};

export const lightingOf = l => ({
  scene: SCENES.includes(l?.scene) ? l.scene : DEFAULT_LIGHTING.scene,
  ceiling: CEILINGS.includes(l?.ceiling) ? l.ceiling : DEFAULT_LIGHTING.ceiling,
  lampsOn: typeof l?.lampsOn === 'boolean' ? l.lampsOn : null
});

// Are the lamps on: the 💡 override or the scene default.
export function lampsOn(l) {
  const s = lightingOf(l);
  return s.lampsOn ?? PRESETS[s.scene].lamps;
}

/**
 * Light levels the scene moves to: numbers and '#rrggbb' colours only, so they can be interpolated.
 * ceil / fix — multipliers of the ceiling fixture and of floor lamps / sconces; shade — glow of lamp shades;
 * bounce — the lamps' light reflected by the walls and the ceiling (added to the sky light; no GI in the scene).
 * Lamps switched off (L) are off: no light and no glow.
 */
export function targetsFor(l) {
  const s = lightingOf(l), p = PRESETS[s.scene], on = lampsOn(s);
  return {
    hemi: p.hemi, env: p.env, sky: p.sky,
    sunColor: p.sun.color, sunPower: p.sun.power, sunHeight: p.sun.height,
    // By day the eye is used to the sun: the same lamps read dimmer (no washed-out rooms with the lights on).
    ceil: on ? (s.scene === 'day' ? 0.5 : 1) : 0,
    fix: on ? (s.scene === 'day' ? 0.6 : 1) : 0,
    shade: on ? (s.scene === 'day' ? 1.4 : 1.8) : 0,
    bounce: on ? Math.max(0, BOUNCE - p.hemi) : 0
  };
}

export const easeInOut = t => t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;

// ---------- ceiling fixtures ----------
// Floor illuminance under a fixture with the lamps on (the scale of the 3D lights: candela / m²). The old lights
// gave 5–11 here and washed the room out; ≈ 1.6 keeps the walls in their colour at the ACES exposure of the scene.
export const FLOOR_LUX = 1.6;
// A recessed downlight: a bright core straight down and a wide soft spill, so on a wall ~0.6 m away the scallop
// starts ≈ 0.5 m under the ceiling, as in a real room. The light stays in its room (the 3D clips it, see clip).
const SPOT = { angle: 0.9, penumbra: 0.75 };
// A chandelier or a pendant under its shades: a wide cone down and to the sides, clipped to its room like the spots.
// A bare point light half a metre under the ceiling gave the ceiling ~20× the light of the floor (a glaring hot spot)
// and, without a shadow map, shone through the partitions onto the next rooms and the outer walls.
const HANG = { angle: 1.35, penumbra: 0.6 };
const SPOT_WALL = 0.6;          // housings this far from the walls (less in a small room)
const CLIP = 0.09;              // the room rectangle of a spot reaches this far into the walls (half a partition)
const PANEL_MAX = { w: 1.2, d: 0.6 };

// ---------- movable fixtures ----------
// A room's ceiling lights: room.fixtures = [{ id, kind, x, y }] in cm of the room (the centre of the fixture).
// A room without its own list uses the default layout of the apartment's ceiling type (lighting.ceiling), so old
// projects look as before; moving or adding a fixture gives the room its own list.
export const FIXTURE_KINDS = ['chandelier', 'pendant', 'spot', 'panel'];
export const FIXTURE_WALL = 20;      // cm: a fixture keeps this far from the walls

// Evenly from SPOT_WALL off one wall to SPOT_WALL off the other (metres).
function spotGrid(L, W) {
  const nx = L > 4.2 ? 3 : 2, nz = W > 3.6 ? 3 : 2;
  const at = (len, n) => { const m = Math.min(SPOT_WALL, len / 4); return Array.from({ length: n }, (_, i) => m + (len - 2 * m) * i / (n - 1)); };
  const out = [];
  for (const x of at(L, nx)) for (const z of at(W, nz)) out.push({ x, z });
  return out;
}

/** The default layout of a ceiling type in a room of L × W cm. */
export function defaultFixtures(ceiling, L, W) {
  const c = lightingOf({ ceiling }).ceiling;
  if (c === 'chandelier' || c === 'panel') return [{ id: 1, kind: c, x: L / 2, y: W / 2 }];
  if (c === 'spots') return spotGrid(L / 100, W / 100).map((d, i) => ({ id: i + 1, kind: 'spot', x: d.x * 100, y: d.z * 100 }));
  return [];
}

/** The fixtures of a room doc (its own list or the default layout). */
export const fixturesOf = (doc, lighting) => Array.isArray(doc?.fixtures) ? doc.fixtures
  : defaultFixtures(lightingOf(lighting).ceiling, doc?.room?.L || 0, doc?.room?.W || 0);

/** Keep a fixture on the ceiling of the room, FIXTURE_WALL off the walls. */
export function clampFixture(x, y, L, W) {
  const m = Math.min(FIXTURE_WALL, L / 2, W / 2);
  return { x: Math.min(L - m, Math.max(m, x)), y: Math.min(W - m, Math.max(m, y)) };
}

/**
 * Lamps that cast a shadow: indices of the n most powerful point and spot lights (area lights cast none);
 * the first one on a tie, so a room keeps the same shadows while nothing changes.
 */
export function shadowSlots(lights, n) {
  return lights.map((l, i) => [l, i]).filter(([l]) => l.type !== 'area')
    .sort((a, b) => b[0].power - a[0].power || a[1] - b[1]).slice(0, Math.max(0, n)).map(([, i]) => i).sort((a, b) => a - b);
}

/**
 * The light sources of a room's ceiling fixtures, sizes in metres, the room from (0, 0) to (L, W), ceiling at H;
 * fixtures in cm of the room.
 * spot / point: { type, x, y, z, power (cd), distance (m, 0 = no cut-off) [, angle, penumbra], fixture };
 * area: { type: 'area', x, y, z, w, d, power (nits), fixture }. discs: where the spot housings are.
 * merged: the spots as one wide down-light with the same light output (the lamp budget is spent).
 */
export function fixturesSpec(fixtures, L, W, H, { merged = false } = {}) {
  const reach = Math.hypot(L, W) / 2 + H;               // the light fades out just past the far corner
  const lights = [], discs = [], spotsAt = [];
  const clip = { x0: -CLIP, z0: -CLIP, x1: L + CLIP, z1: W + CLIP };
  const yS = H - 0.02, one = FLOOR_LUX * yS * yS * 0.55;   // the wide spills of a grid overlap: less each
  for (const f of fixtures || []) {
    const x = f.x / 100, z = f.y / 100;
    if (f.kind === 'chandelier' || f.kind === 'pendant') {
      const y = H - (f.kind === 'pendant' ? 0.7 : 0.5), k = f.kind === 'pendant' ? 0.6 : 1;
      lights.push({ type: 'spot', x, y, z, power: FLOOR_LUX * y * y * k, ...HANG, distance: reach * 1.2, clip, fixture: f.id });
    } else if (f.kind === 'spot') {
      discs.push({ x, z, fixture: f.id });
      spotsAt.push({ x, z, fixture: f.id });
    } else if (f.kind === 'panel') {
      const w = Math.min(PANEL_MAX.w, L * 0.4), d = Math.min(PANEL_MAX.d, W * 0.3), y = H - 0.025;
      // A small panel straight above: E ≈ L·A / h².
      lights.push({ type: 'area', x, y, z, w, d, power: FLOOR_LUX * y * y / (w * d), fixture: f.id });
    }
  }
  const distance = yS / Math.cos(SPOT.angle) * 1.3;     // fades out past the far floor corner
  if (merged && spotsAt.length > 1) {
    // Same light output: n · I · 2π(1 − cos a) = I₁ · 2π(1 − cos A), from the middle of the housings.
    const A = 1.1, power = spotsAt.length * one * (1 - Math.cos(SPOT.angle)) / (1 - Math.cos(A));
    const cx = spotsAt.reduce((s, p) => s + p.x, 0) / spotsAt.length, cz = spotsAt.reduce((s, p) => s + p.z, 0) / spotsAt.length;
    lights.push({ type: 'spot', x: cx, y: yS, z: cz, power, angle: A, penumbra: 1, distance: yS / Math.cos(A) * 1.1, clip });
  } else {
    for (const p of spotsAt) lights.push({ type: 'spot', x: p.x, y: yS, z: p.z, power: one, ...SPOT, distance, clip, fixture: p.fixture });
  }
  return { lights, discs };
}

/** The default fixtures of a ceiling type (see fixturesSpec). */
export const fixtureSpec = (ceiling, L, W, H, opts) => fixturesSpec(defaultFixtures(ceiling, L * 100, W * 100), L, W, H, opts);

/** Floor illuminance at (x, z) from a fixture spec (inverse square, cosine, spot cone, distance cut-off, room clip). */
export function floorLux(spec, x, z) {
  let e = 0;
  for (const l of spec.lights) {
    const dx = x - l.x, dz = z - l.z, h = l.y, d2 = dx * dx + dz * dz + h * h, d = Math.sqrt(d2), cos = h / d;
    let k = 1;
    if (l.clip && (x < l.clip.x0 || x > l.clip.x1 || z < l.clip.z0 || z > l.clip.z1)) continue;
    if (l.type === 'spot') {
      const a = Math.acos(cos), inner = l.angle * (1 - l.penumbra);
      k = a >= l.angle ? 0 : a <= inner ? 1 : (l.angle - a) / (l.angle - inner);
    }
    if (l.distance) k *= Math.max(0, 1 - (d / l.distance) ** 4) ** 2;
    const I = l.type === 'area' ? l.power * l.w * l.d * cos : l.power;
    e += I * cos / d2 * k;
  }
  return e;
}
