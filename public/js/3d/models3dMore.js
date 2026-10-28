// More furniture models: bathroom, kitchen modules, living room, kids, hallway, decor.
// Same rules as models3d.js: (w, d, h, color, status) in metres → Group; origin at the footprint
// centre on the floor, front faces +Z, the wall side is −Z. Wall items are lifted by elev in buildItem.
import * as THREE from 'three';
import { furnitureMat } from './textures3d.js';
import {
  conf, box, slab, rbox, cyl, taper, cushion, fm, handle, leg, panel, hinged, flap, slider, sinkBowl, tap, hob, lampHead,
  wardrobe, bed, art3d
} from './models3d.js';
import { artTexture as namedArt } from './art3d.js';

const mat = (kind, c, s) => furnitureMat(kind, c, s);

// ---------- bathroom ----------

// Bath: an enamel shell with a rounded hollow, a drain and a mixer on the wall side.
function bathtub(w, d, h, c, s) {
  const g = new THREE.Group(), cer = mat('ceramic', c, s);
  const sideT = Math.min(0.08, w * 0.06), endT = Math.min(0.1, w * 0.08);
  // Rim: four rounded walls around the hollow; the front apron is the outer face.
  g.add(rbox(w, h, sideT, cer, 0, 0, d / 2 - sideT / 2, 0.02));
  g.add(rbox(w, h, sideT, cer, 0, 0, -d / 2 + sideT / 2, 0.02));
  for (const sx of [-1, 1]) g.add(rbox(endT, h, d - 2 * sideT + 0.02, cer, sx * (w / 2 - endT / 2), 0, 0, 0.02));
  g.add(box(w - 2 * endT, 0.04, d - 2 * sideT, cer, 0, 0, 0));
  g.add(sinkBowl(w - 2 * endT + 0.01, d - 2 * sideT + 0.01, 0, h, 0, s, h - 0.05, cer));
  g.add(cyl(0.022, 0.004, mat('chrome', '', s), -w / 2 + endT + 0.12, 0.05, 0));                 // drain
  g.add(tap(-w / 2 + endT / 2, h, -d / 2 + sideT / 2, 0.2, s));
  return g;
}

// Shower cabin: a low tray, an acrylic back panel, glass sides and a hinged glass door, a rain head.
function shower(w, d, h, c, s) {
  const g = new THREE.Group(), cer = mat('ceramic', '#f7f7f5', s), glass = mat('glass', '', s), ch = mat('chrome', '', s);
  const tray = 0.12;
  g.add(rbox(w, tray, d, cer, 0, 0, 0, 0.02));
  g.add(sinkBowl(w - 0.1, d - 0.1, 0, tray, 0, s, 0.04, cer));
  g.add(box(w, h - tray, 0.02, mat('ceramic', c, s), 0, tray, -d / 2 + 0.01));                // back panel
  for (const sx of [-1, 1]) {
    g.add(box(0.008, h - tray - 0.02, d - 0.04, glass, sx * (w / 2 - 0.004), tray, 0.01));
    g.add(box(0.02, h - tray, 0.02, ch, sx * (w / 2 - 0.01), tray, d / 2 - 0.01));             // posts
  }
  g.add(box(w, 0.02, 0.02, ch, 0, h - 0.02, d / 2 - 0.01));                                   // top rail
  const leaf = new THREE.Group();
  leaf.add(box(w - 0.06, h - tray - 0.06, 0.008, glass, 0, tray + 0.02, d / 2 - 0.01));
  leaf.add(box(0.015, 0.3, 0.03, ch, w / 2 - 0.1, tray + 0.9, d / 2 + 0.01));
  g.add(hinged(leaf, -w / 2 + 0.03, d / 2 - 0.01, -1));
  // Rain head and a hand shower on a rail.
  g.add(box(0.02, 0.02, 0.3, ch, 0, h - 0.18, -d / 2 + 0.17));
  g.add(cyl(0.11, 0.012, ch, 0, h - 0.2, -d / 2 + 0.3));
  g.add(box(0.02, 0.7, 0.02, ch, w * 0.25, tray + 0.8, -d / 2 + 0.04));
  return g;
}

// Toilet: tank on the wall side, a pedestal, an oval bowl with a seat and a closed lid.
function toilet(w, d, h, c, s) {
  const g = new THREE.Group(), cer = mat('ceramic', c, s), ch = mat('chrome', '', s);
  const tankD = Math.min(0.2, d * 0.3), seatY = Math.min(0.42, h * 0.52);
  g.add(rbox(w * 0.95, h - seatY + 0.02, tankD, cer, 0, seatY - 0.02, -d / 2 + tankD / 2, 0.03));
  g.add(cyl(0.022, 0.008, ch, 0, h, -d / 2 + tankD / 2));                                     // flush button
  const bd = d - tankD + 0.04, bz = -d / 2 + tankD - 0.04 + bd / 2;
  const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.38, seatY - 0.06, 24), cer);
  ped.scale.set(w * 0.7, 1, bd * 0.75);
  ped.position.set(0, (seatY - 0.06) / 2, bz - bd * 0.08);
  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.42, 0.12, 32), cer);
  bowl.scale.set(w, 1, bd);
  bowl.position.set(0, seatY - 0.09, bz);
  const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.03, 32), mat('ceramic', '#fbfbf9', s));
  lid.scale.set(w * 0.98, 1, bd * 0.98);
  lid.position.set(0, seatY - 0.015, bz);
  for (const m of [ped, bowl, lid]) { m.castShadow = m.receiveShadow = true; g.add(m); }
  return g;
}

// Vanity unit: a cabinet with doors on a plinth and a ceramic top with a basin and a tap.
function basin(w, d, h, c, s) {
  const g = new THREE.Group(), cer = mat('ceramic', '#f7f7f5', s);
  const top = 0.12, body = fm('solid', c, s), face = fm('solid', c, s, 'facade');
  g.add(box(w - 0.04, 0.1, d - 0.06, mat('plain', '#2b2d31', s), 0, 0, -0.02));
  g.add(box(w, h - top - 0.1, d - 0.02, body, 0, 0.1, -0.01));
  const n = conf().doors > 1 || w > 0.7 ? 2 : 1, dw = (w - 0.006 * (n + 1)) / n;
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + 0.006 + dw / 2 + i * (dw + 0.006), leaf = new THREE.Group();
    leaf.add(box(dw, h - top - 0.12, 0.018, face, x, 0.11, d / 2 - 0.009));
    panel(leaf, dw, h - top - 0.12, x, 0.11, d / 2, face);
    const hx = n === 1 ? x + dw / 2 - 0.05 : x + (i ? -1 : 1) * (dw / 2 - 0.05);
    leaf.add(handle(box(0.012, 0.12, 0.02, mat('chrome', '', s), hx, h - top - 0.2, d / 2 + 0.01), hx, h - top - 0.2, d / 2 + 0.01, 0.12, true, s));
    const left = n === 1 || i === 0;
    g.add(hinged(leaf, left ? x - dw / 2 : x + dw / 2, d / 2 - 0.009, left ? -1 : 1));
  }
  // Ceramic top: rim around the bowl.
  const bw = Math.min(w - 0.12, 0.48), bd = d * 0.55, bz = 0.03;
  g.add(slab(w, top, d, cer, 0, h - top, 0, { w: bw, d: bd, x: 0, z: bz }));
  g.add(sinkBowl(bw, bd, 0, h, bz, s, top - 0.02, cer));
  g.add(tap(0, h, -d / 2 + 0.07, 0.24, s));
  return g;
}

// Front-loading washing machine: rounded body, control strip, round glass door.
function washer(w, d, h, c, s) {
  const g = new THREE.Group(), body = mat('plain', c, s), ch = mat('chrome', '', s);
  g.add(rbox(w, h, d - 0.02, body, 0, 0, -0.01, 0.015));
  g.add(box(w - 0.04, 0.1, 0.004, mat('plain', '#d9dde1', s), 0, h - 0.13, d / 2 - 0.018));
  g.add(cyl(0.025, 0.02, ch, w * 0.3, h - 0.08, d / 2 - 0.02).rotateX(Math.PI / 2));
  const r = Math.min(w, h) * 0.3, cy = h * 0.45, door = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.025, 12, 40), ch);
  ring.position.set(0, cy, d / 2 - 0.005);
  const glass = new THREE.Mesh(new THREE.CircleGeometry(r, 40), mat('screen', '', s));
  glass.position.set(0, cy, d / 2 - 0.004);
  door.add(ring, glass);
  g.add(hinged(door, -r - 0.03, d / 2 - 0.005, -1));
  return g;
}

// Heated towel rail: two chrome stiles and rungs, stand-offs to the wall.
function towelrail(w, d, h, c, s) {
  const g = new THREE.Group(), ch = mat('chrome', '', s), z = d / 2 - 0.015;
  for (const sx of [-1, 1]) {
    g.add(cyl(0.013, h, ch, sx * (w / 2 - 0.015), 0, z));
    for (const y of [0.12, h - 0.12]) g.add(box(0.012, 0.012, d - 0.02, ch, sx * (w / 2 - 0.015), y, -0.005));
  }
  const n = Math.max(3, Math.round(h / 0.11));
  for (let k = 0; k < n; k++) {
    const bar = cyl(0.009, w - 0.03, ch, 0, 0, z);
    bar.rotation.z = Math.PI / 2;
    bar.position.y = 0.06 + k * (h - 0.12) / (n - 1);
    g.add(bar);
  }
  return g;
}

// Mirror cabinet: shallow box with mirror doors and a light strip at the bottom.
function mirrorcab(w, d, h, c, s) {
  const g = new THREE.Group(), body = fm('solid', c, s);
  const mirrorMat = new THREE.MeshStandardMaterial({ color: '#dfe7ef', roughness: 0.03, metalness: 1 });
  g.add(box(w, h, d - 0.02, body, 0, 0, -0.01));
  const n = w > 0.7 ? 2 : 1, dw = (w - 0.004 * (n + 1)) / n;
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + 0.004 + dw / 2 + i * (dw + 0.004), leaf = new THREE.Group();
    leaf.add(box(dw, h - 0.008, 0.016, body, x, 0.004, d / 2 - 0.008));
    leaf.add(box(dw - 0.01, h - 0.02, 0.004, mirrorMat, x, 0.01, d / 2 + 0.002));
    const left = n === 1 || i === 0;
    g.add(hinged(leaf, left ? x - dw / 2 : x + dw / 2, d / 2 - 0.008, left ? -1 : 1));
  }
  const stripMat = new THREE.MeshStandardMaterial({ color: '#fff7e6', emissive: '#fff1d6', emissiveIntensity: 0.6 });
  stripMat.userData.glow = 0.6;
  const strip = box(w - 0.06, 0.01, 0.02, stripMat, 0, -0.012, 0);
  strip.castShadow = false;
  g.add(strip);
  return g;
}

// Water heater: a white vertical tank with domed ends and two pipes.
function boiler(w, d, h, c, s) {
  const g = new THREE.Group(), cer = mat('ceramic', c, s), ch = mat('chrome', '', s);
  const r = Math.min(w, d) / 2 - 0.005, body = h - 2 * r * 0.35;
  const tank = cyl(r, body, cer, 0, r * 0.35, 0);
  g.add(tank);
  for (const [y, sy] of [[r * 0.35, -1], [r * 0.35 + body, 1]]) {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 12, 0, Math.PI * 2, sy > 0 ? 0 : Math.PI / 2, Math.PI / 2), cer);
    cap.scale.y = 0.35;
    cap.position.y = y;
    cap.castShadow = true;
    g.add(cap);
  }
  for (const sx of [-1, 1]) g.add(cyl(0.01, 0.12, ch, sx * 0.05, -0.1, 0));
  g.add(cyl(0.03, 0.01, mat('plain', '#4a90d9', s), 0, h * 0.45, r - 0.002).rotateX(Math.PI / 2));
  return g;
}

// ---------- kitchen modules ----------

// Base cabinet: plinth, carcass, countertop; front = 'doors' | 'drawers' | 'flap' | 'oven'.
function baseUnit(w, d, h, c, s, front, hole) {
  const g = new THREE.Group();
  const body = fm('plain', c, s), face = fm('plain', c, s, 'facade'), metal = mat('metal', '', s);
  const plinth = 0.1, ct = 0.038, fh = h - plinth - ct - 0.008;
  g.add(box(w, plinth, d - 0.06, mat('plain', '#202124', s), 0, 0, -0.03));
  g.add(box(w, h - plinth - ct, d - 0.04, body, 0, plinth, -0.02));
  g.add(slab(w, ct, d, mat('plain', '#5d5f63', s), 0, h - ct, 0, hole));
  const zf = d / 2 - 0.029;
  if (front === 'drawers') {
    const n = Math.max(1, conf().drawers || 3), dh = (fh - 0.004 * (n - 1)) / n;
    for (let i = 0; i < n; i++) {
      const y = plinth + 0.004 + i * (dh + 0.004), leaf = new THREE.Group(), hl = Math.min(0.2, w * 0.4);
      leaf.add(box(w - 0.006, dh, 0.018, face, 0, y, zf));
      leaf.add(box(w - 0.06, dh * 0.6, d * 0.7, body, 0, y + 0.01, zf - d * 0.35));
      panel(leaf, w - 0.006, dh, 0, y, zf + 0.009, face);
      leaf.add(handle(box(hl, 0.012, 0.02, metal, 0, y + dh - 0.05, zf + 0.02), 0, y + dh - 0.05, zf + 0.02, hl, false, s));
      g.add(slider(leaf, d * 0.6));
    }
  } else if (front === 'flap' || front === 'oven') {
    const leaf = new THREE.Group();
    leaf.add(box(w - 0.006, fh, 0.02, face, 0, plinth + 0.004, zf));
    if (front === 'oven') leaf.add(box(w - 0.1, fh * 0.45, 0.004, mat('screen', '', s), 0, plinth + fh * 0.25, zf + 0.012));
    leaf.add(box(w * 0.7, 0.015, 0.025, mat('chrome', '', s), 0, plinth + fh - 0.07, zf + 0.022));
    g.add(flap(leaf, plinth + 0.004, zf));
  } else {
    const n = w > 0.65 ? 2 : 1, dw = (w - 0.006 * (n + 1)) / n;
    for (let i = 0; i < n; i++) {
      const x = -w / 2 + 0.006 + dw / 2 + i * (dw + 0.006), leaf = new THREE.Group(), hl = Math.min(0.2, dw * 0.5);
      leaf.add(box(dw, fh, 0.018, face, x, plinth + 0.004, zf));
      panel(leaf, dw, fh, x, plinth + 0.004, zf + 0.009, face);
      leaf.add(handle(box(hl, 0.012, 0.02, metal, x, h - ct - 0.06, zf + 0.02), x, h - ct - 0.06, zf + 0.02, hl, false, s));
      const left = n === 1 || i === 0;
      g.add(hinged(leaf, left ? x - dw / 2 : x + dw / 2, zf, left ? -1 : 1));
    }
  }
  return g;
}

const basecab = (w, d, h, c, s) => baseUnit(w, d, h, c, s, 'drawers');

function sinkunit(w, d, h, c, s) {
  const sw = Math.min(w - 0.14, 0.55), sd = d * 0.62;
  const g = baseUnit(w, d, h, c, s, 'doors', { w: sw, d: sd, x: 0, z: 0.02 });
  g.add(sinkBowl(sw, sd, 0, h, 0.02, s, 0.18));
  g.add(tap(0, h, -d / 2 + 0.07, 0.3, s));
  return g;
}

function dishwasher(w, d, h, c, s) {
  const g = baseUnit(w, d, h, c, s, 'flap');
  g.add(box(w * 0.5, 0.012, 0.004, mat('screen', '', s), 0, h - 0.07, d / 2 - 0.016));
  return g;
}

// Freestanding cooker: enamel body, glass hob, oven door with a window, knobs.
function stove(w, d, h, c, s) {
  const g = new THREE.Group(), body = mat('plain', c, s), ch = mat('chrome', '', s);
  g.add(rbox(w, h - 0.01, d - 0.03, body, 0, 0, -0.015, 0.01));
  g.add(hob(w - 0.02, d - 0.04, 0, h - 0.01, -0.01, s));
  for (let k = 0; k < 4; k++) g.add(cyl(0.016, 0.02, mat('plain', '#2b2d31', s), -w / 2 + 0.1 + k * (w - 0.2) / 3, h - 0.07, d / 2 - 0.02).rotateX(Math.PI / 2));
  const leaf = new THREE.Group(), dh = h * 0.6;
  leaf.add(box(w - 0.02, dh, 0.025, body, 0, 0.08, d / 2 - 0.028));
  leaf.add(box(w - 0.12, dh * 0.55, 0.004, mat('screen', '', s), 0, 0.08 + dh * 0.22, d / 2 - 0.013));
  const bar = cyl(0.01, w * 0.7, ch, 0, 0, 0);
  bar.rotation.z = Math.PI / 2;
  bar.position.set(0, 0.08 + dh - 0.05, d / 2 + 0.01);
  leaf.add(bar);
  g.add(flap(leaf, 0.08, d / 2 - 0.028));
  return g;
}

// Kitchen island: drawers on both long sides and a thick overhanging top.
function island(w, d, h, c, s) {
  const g = new THREE.Group(), core = d * 0.62;
  const front = baseUnit(w - 0.1, core / 2, h - 0.02, c, s, 'drawers');
  front.position.z = core / 4;
  const back = baseUnit(w - 0.1, core / 2, h - 0.02, c, s, 'doors');
  back.position.z = -core / 4;
  back.rotation.y = Math.PI;
  g.add(front, back);
  g.add(rbox(w, 0.04, d, mat('plain', '#e9e4dc', s), 0, h - 0.04, 0, 0.008));
  return g;
}

function roundtable(w, d, h, c, s) {
  const g = new THREE.Group(), wood = fm('wood', c, s), dark = fm('dark', c, s);
  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.035, 48), wood);
  top.scale.set(w, 1, d);
  top.position.y = h - 0.0175;
  top.castShadow = top.receiveShadow = true;
  g.add(top);
  g.add(taper(0.05, 0.035, h - 0.06, dark, 0, 0.03, 0));
  const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.5, 0.03, 32), dark);
  foot.scale.set(Math.min(w, 0.6), 1, Math.min(d, 0.6));
  foot.position.y = 0.015;
  foot.castShadow = true;
  g.add(foot);
  return g;
}

function barstool(w, d, h, c, s) {
  const g = new THREE.Group(), ch = mat('chrome', '', s);
  const r = Math.min(w, d) / 2;
  g.add(cyl(r * 0.9, 0.012, ch, 0, 0, 0));
  g.add(cyl(0.022, h - 0.08, ch, 0, 0.01, 0));
  const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 0.7, 0.008, 6, 24), ch);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = h * 0.35;
  g.add(ring);
  g.add(taper(r * 0.95, r * 0.85, 0.07, fm('leather', c, s), 0, h - 0.07, 0));
  return g;
}

// ---------- living room ----------

// L-shaped sofa: the long part along the back wall, the chaise on the left side (as on the plan).
function cornersofa(w, d, h, c, s) {
  const g = new THREE.Group(), fab = fm('fabric', c, s), dark = fm('dark', c, s);
  const legH = 0.07, seatH = Math.min(0.45, h * 0.55), baseTop = legH + (seatH - legH) * 0.55;
  const back = 0.22, arm = 0.16, seatD = Math.min(0.95, d - back), chaiseW = Math.min(0.9, w * 0.4);
  // Long seat along the back.
  const lx0 = -w / 2 + back, lx1 = w / 2 - arm, lz0 = -d / 2 + back;
  g.add(rbox(w, h - legH, back, fab, 0, legH, -d / 2 + back / 2, 0.05));                    // back along the wall
  g.add(rbox(back, h - legH, d - back, fab, -w / 2 + back / 2, legH, back / 2, 0.05));       // back along the left side
  g.add(rbox(arm, seatH + 0.15 - legH, seatD, fab, w / 2 - arm / 2, legH, lz0 + seatD / 2, 0.05));    // right arm
  g.add(rbox(chaiseW, seatH + 0.15 - legH, arm, fab, lx0 + chaiseW / 2, legH, d / 2 - arm / 2, 0.05)); // chaise end arm
  g.add(rbox(lx1 - lx0, baseTop - legH, seatD, fab, (lx0 + lx1) / 2, legH, lz0 + seatD / 2, 0.03));
  g.add(rbox(chaiseW, baseTop - legH, d - back - arm - seatD, fab, lx0 + chaiseW / 2, legH, lz0 + seatD + (d - back - arm - seatD) / 2, 0.03));
  const n = Math.max(1, Math.round((lx1 - lx0 - chaiseW) / 0.65)), cw = (lx1 - lx0 - chaiseW) / n;
  for (let i = 0; i < n; i++) g.add(cushion(cw - 0.012, seatH - baseTop, seatD - 0.01, fab, lx0 + chaiseW + cw / 2 + i * cw, baseTop, lz0 + seatD / 2));
  g.add(cushion(chaiseW - 0.012, seatH - baseTop, d - back - arm - 0.01, fab, lx0 + chaiseW / 2, baseTop, lz0 + (d - back - arm) / 2));
  for (const [x, z] of [[-w / 2 + 0.06, -d / 2 + 0.06], [w / 2 - 0.06, -d / 2 + 0.06], [w / 2 - 0.06, lz0 + seatD - 0.06], [-w / 2 + 0.06, d / 2 - 0.06], [lx0 + chaiseW - 0.06, d / 2 - 0.06]]) {
    g.add(leg(taper(0.022, 0.014, legH, dark, x, 0, z), x, z, legH, 0.05, c, s));
  }
  // Back cushions along both backs.
  const bh = Math.min(0.4, h - seatH - 0.02);
  if (bh > 0.15) {
    for (let i = 0; i < n + 1; i++) {
      const x = lx0 + 0.1 + (i + 0.5) * (lx1 - lx0 - 0.1) / (n + 1);
      g.add(cushion((lx1 - lx0 - 0.1) / (n + 1) - 0.02, bh, 0.15, fab, x, seatH - 0.02, lz0 + 0.08));
    }
    g.add(cushion(0.15, bh, 0.6, fab, lx0 + 0.08, seatH - 0.02, lz0 + seatD + 0.25));
  }
  return g;
}

// Sideboard: a cabinet with doors on tapered legs.
function sideboard(w, d, h, c, s) {
  const bare = conf().bare, g = new THREE.Group(), legH = bare ? 0 : Math.min(0.15, h * 0.18), dark = fm('dark', c, s);
  if (!bare) for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * (w / 2 - 0.05), z = sz * (d / 2 - 0.05);
    g.add(leg(taper(0.018, 0.011, legH, dark, x, 0, z), x, z, legH, 0.035, c, s));
  }
  const wood = fm('wood', c, s), face = fm('wood', c, s, 'facade'), metal = mat('metal', '', s), ch = h - legH;
  g.add(box(w, ch, d - 0.02, wood, 0, legH, -0.01));
  if (!bare) g.add(box(w + 0.02, 0.025, d + 0.01, wood, 0, h - 0.025, 0));
  const n = Math.max(2, Math.min(4, Math.round(w / 0.45))), dw = (w - 0.004 * (n + 1)) / n;
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + 0.004 + dw / 2 + i * (dw + 0.004), leaf = new THREE.Group();
    leaf.add(box(dw, ch - 0.035, 0.018, face, x, legH + 0.005, d / 2 - 0.009));
    panel(leaf, dw, ch - 0.035, x, legH + 0.005, d / 2, face);
    const left = i < n / 2, hx = x + (left ? 1 : -1) * (dw / 2 - 0.04), hy = h - 0.025 - 0.17;
    leaf.add(handle(box(0.012, 0.12, 0.02, metal, hx, hy, d / 2 + 0.01), hx, hy, d / 2 + 0.01, 0.12, true, s));
    g.add(hinged(leaf, left ? x - dw / 2 : x + dw / 2, d / 2 - 0.009, left ? -1 : 1));
  }
  return g;
}

// Display cabinet: glass doors over lit shelves with some dishes.
function vitrine(w, d, h, c, s) {
  const g = new THREE.Group(), wood = fm('wood', c, s), glass = mat('glass', '', s);
  const t = 0.02, base = conf().bare ? t : 0.08;
  if (!conf().bare) g.add(box(w, base, d - 0.03, fm('dark', c, s), 0, 0, -0.015));
  for (const sx of [-1, 1]) g.add(box(t, h - base, d - 0.02, wood, sx * (w / 2 - t / 2), base, -0.01));
  g.add(box(w, t, d - 0.02, wood, 0, h - t, -0.01));
  g.add(box(w - 2 * t, h - base, 0.008, wood, 0, base, -d / 2 + 0.004));
  const shelves = Math.max(3, Math.round((h - base) / 0.38));
  const dish = mat('ceramic', '#f3efe6', s);
  for (let k = 0; k < shelves; k++) {
    const y = base + k * (h - base - t) / shelves;
    g.add(box(w - 2 * t, t, d - 0.04, k ? glass : wood, 0, y, -0.01));
    if (k) for (let i = 0; i < 3; i++) g.add(cyl(0.045, 0.02 + 0.06 * (i % 2), dish, -w / 3 + i * w / 3, y + t, -0.02));
  }
  const n = w > 0.7 ? 2 : 1, dw = (w - 0.004 * (n + 1)) / n;
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + 0.004 + dw / 2 + i * (dw + 0.004), leaf = new THREE.Group();
    leaf.add(box(dw, h - base - 0.01, 0.006, glass, x, base + 0.005, d / 2 - 0.01));
    for (const sx of [-1, 1]) leaf.add(box(0.03, h - base - 0.01, 0.018, wood, x + sx * (dw / 2 - 0.015), base + 0.005, d / 2 - 0.01));
    const left = n === 1 || i === 0;
    g.add(hinged(leaf, left ? x - dw / 2 : x + dw / 2, d / 2 - 0.01, left ? -1 : 1));
  }
  const light = new THREE.PointLight('#ffe2b0', 0, 1.2, 2);
  light.position.set(0, h - 0.1, 0);
  light.userData.lampPower = 0.4;
  g.add(light);
  return g;
}

function pouf(w, d, h, c, s) {
  const g = new THREE.Group();
  g.add(rbox(w, h, d, fm('fabric', c, s), 0, 0, 0, Math.min(0.12, h * 0.3)));
  return g;
}

// Flat TV on the wall: a slim black frame with a glossy screen.
function tv(w, d, h, c, s) {
  const g = new THREE.Group();
  g.add(rbox(w, h, d * 0.7, mat('plain', '#1d1f22', s), 0, 0, -d * 0.15, 0.006));
  g.add(box(w - 0.016, h - 0.03, 0.003, mat('screen', '', s), 0, 0.022, d / 2 - 0.002));
  return g;
}

// Painting: a wooden frame and an abstract canvas generated from the item colour.
const artCache = new Map();
function artTexture(color) {
  if (artCache.has(color)) return artCache.get(color);
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 192;
  const g = cv.getContext('2d');
  const base = new THREE.Color(color);
  g.fillStyle = '#' + base.clone().lerp(new THREE.Color('#f4efe6'), 0.75).getHexString();
  g.fillRect(0, 0, 256, 192);
  let k = [...color].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7) >>> 0;
  const rnd = () => ((k = (k * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let i = 0; i < 9; i++) {
    const col = base.clone().offsetHSL(rnd() * 0.3 - 0.15, rnd() * 0.3 - 0.1, rnd() * 0.4 - 0.2);
    g.fillStyle = '#' + col.getHexString();
    g.globalAlpha = 0.55 + rnd() * 0.4;
    g.beginPath();
    if (i % 3) g.arc(rnd() * 256, rnd() * 192, 15 + rnd() * 60, 0, Math.PI * 2);
    else g.rect(rnd() * 200, rnd() * 150, 30 + rnd() * 100, 20 + rnd() * 80);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  artCache.set(color, tex);
  return tex;
}

function painting(w, d, h, c, s) {
  const g = new THREE.Group(), frame = fm('dark', c, s), f = Math.min(0.03, w * 0.08);
  g.add(box(w, h, d, frame, 0, 0, 0));
  const canvasMat = new THREE.MeshStandardMaterial({ map: namedArt(art3d()) || artTexture(c), roughness: 0.85 });
  if (s !== 'ok') canvasMat.emissive.set(s === 'bad' ? '#ff1a1a' : '#16c060'), canvasMat.emissiveIntensity = 0.35;
  g.add(box(w - 2 * f, h - 2 * f, 0.004, canvasMat, 0, f, d / 2));
  return g;
}

// Potted plant: a tapered pot, soil and leaves on a spiral of stems (deterministic).
function plant(w, d, h, c, s) {
  const g = new THREE.Group(), r = Math.min(w, d) / 2, potH = Math.min(0.35, h * 0.3);
  g.add(taper(r * 0.75, r * 0.55, potH, mat('ceramic', '#d8d2c6', s), 0, 0, 0));
  g.add(cyl(r * 0.7, 0.01, mat('plain', '#3b2b20', s), 0, potH - 0.02, 0));
  const leafMat = mat('leaf', c, s), stem = mat('plain', '#5a6b3a', s);
  const shape = new THREE.Shape();
  shape.moveTo(0, 0); shape.quadraticCurveTo(0.06, 0.12, 0, 0.26); shape.quadraticCurveTo(-0.06, 0.12, 0, 0);
  const leafGeo = new THREE.ShapeGeometry(shape, 6);
  // Stems fan out from the pot (a pivot at the base, turned by azimuth and tilt); leaves along each stem.
  const n = 12, ls = Math.min(1.6, Math.max(0.7, r * 4.5));
  for (let i = 0; i < n; i++) {
    const a = i * 2.4, t = i / (n - 1), len = (h - potH) * (0.55 + 0.45 * (1 - t));
    const piv = new THREE.Group();
    piv.position.y = potH - 0.02;
    piv.rotation.set(0, a, 0.12 + 0.45 * t);          // outer stems lean more
    piv.add(cyl(0.006, len, stem, 0, 0, 0));
    for (const f of [0.55, 0.8, 1]) {
      const lf = new THREE.Mesh(leafGeo, leafMat);
      lf.position.y = len * f - 0.02;
      lf.rotation.set(0, (f * 7 + i) % 6.28, 0.9 + 0.4 * f);   // leaves spread around and bend outwards
      lf.scale.setScalar(ls * (0.7 + 0.3 * f));
      lf.castShadow = true;
      piv.add(lf);
    }
    g.add(piv);
  }
  return g;
}

// Table lamp standing on a nightstand / desk (elev = its height).
function tablelamp(w, d, h, c, s) {
  const g = new THREE.Group(), r = Math.min(w, d) / 2;
  const body = new THREE.Mesh(new THREE.SphereGeometry(r * 0.5, 24, 16), mat('ceramic', '#cfc6b4', s));
  body.scale.y = 1.3;
  body.position.y = r * 0.6;
  body.castShadow = true;
  g.add(body);
  g.add(cyl(0.008, h * 0.35, mat('chrome', '', s), 0, r * 1.1, 0));
  const hh = h * 0.42, head = lampHead(r * 0.6, r * 0.95, hh, c, s, 1.2);
  head.position.y = h - hh;
  g.add(head);
  return g;
}

// Rug: a thin pile with a border; it only receives shadows.
function rug(w, d, h, c, s) {
  const g = new THREE.Group(), th = Math.max(0.006, h);
  const border = new THREE.Color(c).offsetHSL(0, -0.05, -0.12).getStyle();
  const a = box(w, th, d, mat('rug', border, s));
  const b = box(w - 0.16, 0.002, d - 0.16, mat('rug', c, s), 0, th, 0);
  for (const m of [a, b]) { m.castShadow = false; m.receiveShadow = true; g.add(m); }
  return g;
}

// Curtains: a rod and two pleated panels gathered at the sides of the window.
function curtains(w, d, h, c, s) {
  const g = new THREE.Group(), fabMat = fm('fabric', c, s).clone(), pw = w * 0.32;
  fabMat.side = THREE.DoubleSide;
  const rod = cyl(0.012, w, mat('black', '', s), 0, 0, -d / 2 + 0.06);
  rod.rotation.z = Math.PI / 2;
  rod.position.y = h - 0.02;
  g.add(rod);
  for (const sx of [-1, 1]) {
    const geo = new THREE.PlaneGeometry(pw, h - 0.04, 24, 1);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) p.setZ(i, Math.sin(p.getX(i) / pw * Math.PI * 9) * 0.025);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, fabMat);
    m.position.set(sx * (w / 2 - pw / 2), (h - 0.04) / 2, -d / 2 + 0.06);
    m.castShadow = m.receiveShadow = true;
    g.add(m);
  }
  return g;
}

// ---------- bedroom / kids ----------

// Bunk bed: four posts, two mattresses, rails on top and a ladder at the front.
function bunkbed(w, d, h, c, s) {
  const g = new THREE.Group(), wood = fm('wood', c, s), soft = mat('soft', c, s), fab = fm('fabric', '#6f8fbf', s);
  const post = 0.06, low = 0.25, up = h - 0.55;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(box(post, h, post, wood, sx * (w / 2 - post / 2), 0, sz * (d / 2 - post / 2)));
  for (const y of [low, up]) {
    g.add(box(w - 0.02, 0.05, d - 0.02, wood, 0, y - 0.05, 0));
    g.add(rbox(w - 0.1, 0.14, d - 0.1, soft, 0, y, 0, 0.04));
    g.add(rbox(w - 0.08, 0.04, (d - 0.1) * 0.6, fab, 0, y + 0.13, d * 0.18, 0.015));
    g.add(cushion(w - 0.25, 0.09, 0.32, soft, 0, y + 0.13, -d / 2 + 0.27));
  }
  for (const sz of [-1, 1]) g.add(box(w - 0.02, 0.06, 0.03, wood, 0, h - 0.06, sz * (d / 2 - 0.015)));
  g.add(box(0.03, 0.06, d * 0.55, wood, w / 2 - 0.015, h - 0.06, -d * 0.2));
  g.add(box(0.03, 0.06, d * 0.55, wood, -w / 2 + 0.015, h - 0.06, -d * 0.2));
  // Ladder at the front right.
  const lx = w / 2 - 0.2;
  for (const dx of [-0.17, 0.17]) g.add(box(0.03, up + 0.2, 0.03, wood, lx + dx, 0, d / 2 + 0.0));
  for (let k = 1; k <= 4; k++) g.add(box(0.34, 0.025, 0.03, wood, lx, k * (up + 0.1) / 5, d / 2));
  return g;
}

// Cot: slatted sides around a mattress raised to the middle.
function cot(w, d, h, c, s) {
  const g = new THREE.Group(), wood = fm('wood', c, s), soft = mat('soft', c, s);
  const post = 0.045, my = h * 0.42;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(box(post, h, post, wood, sx * (w / 2 - post / 2), 0, sz * (d / 2 - post / 2)));
  g.add(box(w - 2 * post, 0.03, d - 2 * post, wood, 0, my - 0.03, 0));
  g.add(rbox(w - 2 * post - 0.01, 0.1, d - 2 * post - 0.01, soft, 0, my, 0, 0.03));
  for (const y of [h - 0.04, my + 0.12]) {
    for (const sz of [-1, 1]) g.add(box(w - 2 * post, 0.035, 0.025, wood, 0, y, sz * (d / 2 - 0.02)));
    for (const sx of [-1, 1]) g.add(box(0.025, 0.035, d - 2 * post, wood, sx * (w / 2 - 0.02), y, 0));
  }
  const n = Math.round((d - 2 * post) / 0.075);
  for (let k = 1; k < n; k++) for (const sx of [-1, 1]) {
    const z = -d / 2 + post + k * (d - 2 * post) / n;
    g.add(cyl(0.009, h - 0.04 - my - 0.12, wood, sx * (w / 2 - 0.02), my + 0.12, z));
  }
  const m = Math.round((w - 2 * post) / 0.075);
  for (let k = 1; k < m; k++) for (const sz of [-1, 1]) {
    const x = -w / 2 + post + k * (w - 2 * post) / m;
    g.add(cyl(0.009, h - 0.04 - my - 0.12, wood, x, my + 0.12, sz * (d / 2 - 0.02)));
  }
  return g;
}

// Dressing table: a slim top with two drawers on tapered legs.
function vanity(w, d, h, c, s) {
  const g = new THREE.Group(), wood = fm('wood', c, s), metal = mat('brass', '', s);
  const top = 0.025, apron = 0.14, lw = 0.018;
  g.add(rbox(w, top, d, wood, 0, h - top, 0, 0.006));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * (w / 2 - 0.04), z = sz * (d / 2 - 0.04);
    g.add(leg(taper(lw, lw * 0.6, h - top, wood, x, 0, z), x, z, h - top, 0.04, c, s));
  }
  const n = conf().drawers || 2, dw = (w - 0.1) / n;
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + 0.05 + dw / 2 + i * dw, leaf = new THREE.Group(), face = fm('wood', c, s, 'facade');
    leaf.add(box(dw - 0.008, apron - 0.01, 0.018, face, x, h - top - apron + 0.005, d / 2 - 0.03));
    leaf.add(box(dw - 0.04, apron * 0.6, d * 0.7, wood, x, h - top - apron + 0.015, d / 2 - 0.04 - d * 0.35));
    leaf.add(handle(cyl(0.01, 0.015, metal, x, h - top - apron / 2 - 0.01, d / 2 - 0.02).rotateX(Math.PI / 2), x, h - top - apron / 2, d / 2 - 0.015, 0.08, false, s));
    g.add(slider(leaf, d * 0.6));
  }
  return g;
}

// ---------- hallway ----------

// Open coat rack: black frame, a hat shelf with hooks, a shoe shelf below.
function hanger(w, d, h, c, s) {
  const g = new THREE.Group(), steel = mat('black', '', s), wood = fm('wood', c, s);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(box(0.025, h, 0.025, steel, sx * (w / 2 - 0.0125), 0, sz * (d / 2 - 0.0125)));
  g.add(box(w, 0.025, d, wood, 0, h - 0.025, 0));
  g.add(box(w - 0.05, 0.025, d, wood, 0, 0.12, 0));
  g.add(box(w - 0.05, 0.025, d, wood, 0, 0.42, 0));
  const rail = cyl(0.01, w - 0.05, mat('chrome', '', s), 0, 0, 0);
  rail.rotation.z = Math.PI / 2;
  rail.position.y = h - 0.12;
  g.add(rail);
  // A couple of coats.
  for (const [x, col] of [[-w * 0.25, '#5d6d7e'], [w * 0.1, '#8d6e63']]) {
    g.add(rbox(0.38, 0.85, 0.1, mat('fabric', col, s), x, h - 0.98, 0, 0.04));
  }
  return g;
}

// Bench: upholstered seat on a wooden frame with a shoe shelf.
function bench(w, d, h, c, s) {
  const g = new THREE.Group(), wood = fm('wood', c, s);
  for (const sx of [-1, 1]) g.add(box(0.03, h - 0.06, d, wood, sx * (w / 2 - 0.015), 0, 0));
  g.add(box(w - 0.06, 0.02, d - 0.02, wood, 0, 0.12, 0));
  g.add(cushion(w, 0.07, d, fm('fabric', '#8e8579', s), 0, h - 0.07, 0));
  return g;
}

const hallwardrobe = (w, d, h, c, s) => wardrobe(w, d, h, c, s);

// Key holder: a small board with hooks and a key.
function keyholder(w, d, h, c, s) {
  const g = new THREE.Group(), ch = mat('chrome', '', s);
  g.add(rbox(w, h, d * 0.5, fm('wood', c, s), 0, 0, -d * 0.25, 0.004));
  const n = Math.max(2, Math.round(w / 0.07));
  for (let k = 0; k < n; k++) g.add(cyl(0.004, 0.03, ch, -w / 2 + (k + 0.5) * w / n, h * 0.25, d * 0.15).rotateX(Math.PI / 2));
  g.add(box(0.012, 0.05, 0.003, mat('brass', '', s), -w / 2 + 0.5 * w / n, h * 0.05, d * 0.25));
  return g;
}

const bed1 = (w, d, h, c, s) => bed(w, d, h, c, s);

export const MORE_BUILDERS = {
  bathtub, shower, toilet, basin, washer, towelrail, mirrorcab, boiler,
  stove, sinkunit, basecab, dishwasher, island, roundtable, barstool,
  cornersofa, sideboard, vitrine, pouf, tv, painting, plant, tablelamp, rug, curtains,
  bed1, bunkbed, cot, vanity,
  hanger, bench, hallwardrobe, keyholder
};
