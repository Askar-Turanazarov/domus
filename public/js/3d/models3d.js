// Procedural furniture models built from primitives and fitted exactly into w × d × h.
// Local space: origin at the footprint centre on the floor, front faces +Z, metres.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { MORE_BUILDERS } from './models3dMore.js';
import { furnitureMat, preloadSets } from './textures3d.js';
import { rectOf } from '../geometry.js';
import { itemLook, familyOf } from '../materials.js';
import { itemStyle, packsOf, isLuxe } from '../style.js';
import { LUXE_BUILDERS, luxePart } from './modelsLuxe.js';
import { dressed } from './modelsDress.js';
import { STYLE_MATS } from '../style.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { openSpec } from '../zones.js';
import { sectionCount, drawerCount, slideDoors } from '../config.js';

// Furniture style of the item being built: 'modern' (as drawn) | 'classic' | 'loft'.
// Only handles, legs and facade mouldings change; the overall size never does.
let sty = 'modern';

// Moving parts of the item being built (doors, flaps, drawers) for the 3D animation, see anim3d.js.
// { obj, type: 'hinge' | 'flap' | 'slide', axis, max (rad or m), part: 'door' | 'drawer' }
let movers = [];
let openKind = null;      // item.open.kind: 'slide' turns wardrobe doors into sliding ones
// Configuration of the item being built (config.js): sections, drawers, doors; bare — a carcass without its own
// base and legs (the style's plinth or frame stands around it, modelsDress.js).
let cfg = { sections: 1, drawers: 0, doors: 1, bare: false };

// Door leaf turning on a vertical hinge line at (hx, hz); sign −1 = hinge on the left, +1 = on the right.
function hinged(leaf, hx, hz, sign) {
  leaf.position.set(-hx, 0, -hz);
  const pivot = new THREE.Group();
  pivot.position.set(hx, 0, hz);
  pivot.add(leaf);
  movers.push({ obj: pivot, type: 'hinge', axis: 'y', max: sign * Math.PI / 2, part: 'door' });
  return pivot;
}

// Fall-front flap hinged at the bottom edge (y = hy, z = hz).
function flap(leaf, hy, hz) {
  leaf.position.set(0, -hy, -hz);
  const pivot = new THREE.Group();
  pivot.position.set(0, hy, hz);
  pivot.add(leaf);
  movers.push({ obj: pivot, type: 'flap', axis: 'x', max: Math.PI / 2, part: 'door' });
  return pivot;
}

// Drawer (front + box) pulled forward by dist, or a sliding door moved along x.
function slider(leaf, dist, axis = 'z', part = 'drawer') {
  movers.push({ obj: leaf, type: 'slide', axis, max: dist, part });
  return leaf;
}

// Handle: modern keeps the original bar / knob, classic — a brass knob, loft — a black bar.
// (x, y, z) — where the original was placed: y = its bottom, z = its centre.
function handle(orig, x, y, z, len, vertical, s) {
  if (isLuxe(sty)) return luxeHandle(x, y, z, len, vertical, s);
  if (sty === 'classic') {
    const k = new THREE.Mesh(new THREE.SphereGeometry(0.014, 16, 12), furnitureMat('brass', '', s));
    k.position.set(x, y + (vertical ? len / 2 : 0.008), z + 0.004);
    k.castShadow = true;
    return k;
  }
  if (sty === 'loft') {
    const l = Math.max(len, 0.1);
    return vertical ? box(0.02, l, 0.025, furnitureMat('black', '', s), x, y, z + 0.0025)
      : box(l, 0.02, 0.025, furnitureMat('black', '', s), x, y, z + 0.0025);
  }
  return orig;
}

// Leg of height lh: classic — turned wood with a bulb, loft — thin black steel.
function leg(orig, x, z, lh, size, c, s) {
  if (isLuxe(sty)) return luxeLeg(x, z, lh, size, s);
  if (sty === 'classic') {
    const g = new THREE.Group();
    const wood = fm('dark', c, s);
    g.add(cyl(size * 0.32, lh, wood, x, 0, z));
    const r = Math.min(size * 0.5, lh * 0.25);
    const b = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), wood);
    b.position.set(x, lh * 0.55, z);
    b.castShadow = true;
    g.add(b);
    return g;
  }
  if (sty === 'loft') return box(Math.max(0.02, size * 0.6), lh, Math.max(0.02, size * 0.6), furnitureMat('black', '', s), x, 0, z);
  return orig;
}

// Classic facade: a raised moulding frame on the front (zFront = front face).
function panel(g, fw, fh, x, y, zFront, mat) {
  if (isLuxe(sty)) { luxePanel(g, fw, fh, x, y, zFront, mat); return; }
  if (sty !== 'classic' || fw < 0.12 || fh < 0.1) return;
  const m = Math.min(0.05, fw * 0.12, fh * 0.12), t = 0.012, dz = 0.006, z = zFront + dz / 2;
  g.add(box(fw - 2 * m, t, dz, mat, x, y + m, z));
  g.add(box(fw - 2 * m, t, dz, mat, x, y + fh - m - t, z));
  g.add(box(t, fh - 2 * m, dz, mat, x - fw / 2 + m + t / 2, y + m, z));
  g.add(box(t, fh - 2 * m, dz, mat, x + fw / 2 - m - t / 2, y + m, z));
}

// ---- luxe collections on the base models (cabinets, kitchens, shelves …): hardware, legs, facades ----
// milano — slim bronze edge pulls, no mouldings; couture — brass knob on a rosette, brass moulding frame;
// deco — long brass bars, fluted fronts; organic — flat oak knobs, plain fronts.
const metalOf = (c, s) => sty === 'modern' ? furnitureMat('metal', c, s) : luxePart('metal', s);

function luxeHandle(x, y, z, len, vertical, s) {
  const metal = luxePart('metal', s), g = new THREE.Group();
  if (sty === 'milano') {
    const l = Math.max(len, 0.12);
    g.add(vertical ? box(0.012, l, 0.016, metal, x, y, z) : box(l, 0.012, 0.016, metal, x, y, z));
  } else if (sty === 'couture') {
    const cy = y + (vertical ? len / 2 : 0.008);
    const rose = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.006, 20), metal);
    rose.rotation.x = Math.PI / 2;
    rose.position.set(x, cy, z - 0.006);
    const k = new THREE.Mesh(new THREE.SphereGeometry(0.012, 16, 12), metal);
    k.position.set(x, cy, z);
    g.add(rose, k);
  } else if (sty === 'deco') {
    const l = Math.max(len, 0.18);
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, l, 12), metal);
    if (vertical) bar.position.set(x, y + l / 2, z + 0.006);
    else { bar.rotation.z = Math.PI / 2; bar.position.set(x, y + 0.01, z + 0.006); }
    g.add(bar);
  } else {
    const k = new THREE.Mesh(new THREE.SphereGeometry(0.02, 16, 10), luxePart('body', s));
    k.scale.z = 0.55;
    k.position.set(x, y + (vertical ? len / 2 : 0.01), z + 0.004);
    g.add(k);
  }
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return g;
}

function luxeLeg(x, z, lh, size, s) {
  const metal = luxePart('metal', s), body = luxePart('body', s);
  if (sty === 'milano') return box(0.018, lh, 0.018, metal, x, 0, z);
  if (sty === 'deco') return cyl(Math.max(0.01, size * 0.4), lh, metal, x, 0, z);
  if (sty === 'organic') return taper(size * 0.45, size * 0.3, lh, body, x, 0, z);
  const g = new THREE.Group(), shoe = Math.min(0.04, lh * 0.3);
  g.add(taper(size * 0.42, size * 0.26, lh - shoe, body, x, shoe, z));
  g.add(cyl(size * 0.27, shoe, metal, x, 0, z));
  return g;
}

function luxePanel(g, fw, fh, x, y, zFront, mat) {
  if (fw < 0.12 || fh < 0.1) return;
  const m = Math.min(0.05, fw * 0.12, fh * 0.12);
  if (sty === 'couture') {
    const metal = luxePart('metal', 'ok'), t = 0.007, dz = 0.004, z = zFront + dz / 2;
    g.add(box(fw - 2 * m, t, dz, metal, x, y + m, z));
    g.add(box(fw - 2 * m, t, dz, metal, x, y + fh - m - t, z));
    g.add(box(t, fh - 2 * m, dz, metal, x - fw / 2 + m + t / 2, y + m, z));
    g.add(box(t, fh - 2 * m, dz, metal, x + fw / 2 - m - t / 2, y + m, z));
  } else if (sty === 'deco') {
    // Fluting: half-round reeds over the front, merged into one mesh.
    const r = 0.009, n = Math.min(40, Math.floor((fw - 2 * m) / (2 * r + 0.006))), fl = fh - 2 * m;
    if (n < 2) return;
    const step = (fw - 2 * m) / n, parts = [];
    for (let i = 0; i < n; i++) {
      const c = new THREE.CylinderGeometry(r, r, fl, 8, 1, false, -Math.PI / 2, Math.PI);
      c.translate(x - fw / 2 + m + step * (i + 0.5), y + m + fl / 2, zFront);
      parts.push(c);
    }
    const reeds = new THREE.Mesh(mergeGeometries(parts), mat);
    reeds.castShadow = reeds.receiveShadow = true;
    g.add(reeds);
  }
}

// Look of the item being built: catalog materials for the body and the facade (doors, drawer fronts).
let look = { body: null, facade: null };
let ownColor = null;      // the viewer's colour of the item (setItemColor), else the style's tones
let artName = null;       // item.art: a named painting (art3d.js)
const FAMILY = { wood: 'board', dark: 'board', plain: 'board', fabric: 'fabric' };
// A chosen material replaces the parts of the same family (boards or upholstery); metal, glass etc. stay.
function fm(kind, c, s, role = 'body') {
  const m = look[role];
  if (m && FAMILY[kind] === familyOf(m.kind)) return furnitureMat(m.kind, m.color, s);
  // The style: boards in its woods / fronts, upholstery in its fabric (modelsLuxe.js luxePart).
  if (FAMILY[kind] === 'board') return luxePart(role === 'facade' ? 'facade' : 'body', s, role);
  if (FAMILY[kind] === 'fabric') return luxePart('soft', s, role);
  return furnitureMat(kind, c, s);
}

// Box with UVs scaled to metres (1 texture tile = 1 m) on every face; the grain of the photo (along u) runs along
// the long side of each face, as on real boards: up a door or a side, along a shelf.
function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  // Face order: +x, -x, +y, -y, +z, -z (4 vertices each).
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    const [a, b] = dims[f], turn = b > a;
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v, u0 = uv.getX(i), v0 = uv.getY(i);
      if (turn) uv.setXY(i, v0 * b, u0 * a); else uv.setXY(i, u0 * a, v0 * b);
    }
  }
  const m = new THREE.Mesh(g, mat);
  m.position.set(x, y + h / 2, z);       // y = bottom of the box
  m.castShadow = m.receiveShadow = true;
  return m;
}

// Box with rounded edges (soft furniture, sanitary ware, appliances); y = bottom.
function rbox(w, h, d, mat, x = 0, y = 0, z = 0, r = 0.02) {
  const rad = Math.max(0.001, Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001));
  const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, rad), mat);
  m.position.set(x, y + h / 2, z);
  m.castShadow = m.receiveShadow = true;
  return m;
}

// Tapered round leg (wider at the top), y = bottom.
function taper(rTop, rBottom, h, mat, x, y, z) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, h, 14), mat);
  m.position.set(x, y + h / 2, z);
  m.castShadow = m.receiveShadow = true;
  return m;
}

function cyl(r, h, mat, x, y, z) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 16), mat);
  m.position.set(x, y + h / 2, z);
  m.castShadow = m.receiveShadow = true;
  return m;
}

// Soft cushion: a well rounded box, slightly domed on top.
function cushion(w, h, d, mat, x, y, z) {
  const m = rbox(w, h, d, mat, x, y, z, Math.min(w, h, d) * 0.42);
  m.scale.y = 1.06;
  return m;
}

// ---------- builders: (w, d, h, color, status) → Group ----------
function wardrobe(w, d, h, c, s) {
  const g = new THREE.Group();
  const wood = fm('wood', c, s), metal = metalOf(c, s), dark = fm('dark', c, s);
  const base = cfg.bare ? 0 : Math.min(0.08, h * 0.05), doorT = 0.018, t = 0.018, cd = d - doorT;
  if (base) g.add(box(w - 0.02, base, d - 0.04, dark, 0, 0, -0.01));       // recessed base
  // Hollow carcass: back, sides, top, bottom; inside — partitions between sections, shelves, a rail.
  const zc = -doorT / 2, top = h - t;
  g.add(box(w - 2 * t, h - base, 0.006, wood, 0, base, zc - cd / 2 + 0.003));        // back
  for (const sx of [-1, 1]) g.add(box(t, h - base, cd, wood, sx * (w / 2 - t / 2), base, zc));
  g.add(box(w - 2 * t, t, cd, wood, 0, base, zc));
  g.add(box(w - 2 * t, t, cd, wood, 0, top, zc));
  // Drawers at the bottom (cfg.drawers), the doors start above them.
  const nd = cfg.drawers, dh = 0.17, dz = nd ? nd * dh + t : 0;
  const ns = cfg.sections, inner = w - 2 * t, sw = (inner - (ns - 1) * t) / ns, y0 = base + t + dz;
  for (let k = 0; k < ns; k++) {
    const x0 = -w / 2 + t + k * (sw + t), xc = x0 + sw / 2;
    if (k) g.add(box(t, top - base - t, cd - 0.01, wood, x0 - t / 2, base + t, zc - 0.005));
    if (ns > 1 && k === 0 && sw > 0.4) {
      // Hanging section: a shelf on top and a clothes rail under it.
      g.add(box(sw, t, cd - 0.02, wood, xc, top - 0.3, zc - 0.01));
      const rail = cyl(0.012, sw, metal, xc, 0, zc);
      rail.rotation.z = Math.PI / 2;
      rail.position.y = top - 0.36;
      g.add(rail);
      continue;
    }
    const nsh = Math.max(1, Math.floor((top - y0) / 0.38));
    for (let m = 1; m <= nsh; m++) g.add(box(sw, t, cd - 0.02, wood, xc, y0 + m * (top - y0) / (nsh + 1), zc - 0.01));
  }
  if (nd) g.add(box(inner, t, cd, wood, 0, base + dz, zc));
  const face = fm('wood', c, s, 'facade');
  for (let i = 0; i < nd; i++) {
    const y = base + t / 2 + i * dh + 0.004, fh = dh - 0.008, hl = Math.min(0.2, w * 0.25);
    const leaf = new THREE.Group();
    leaf.add(box(w - 0.012, fh, doorT, face, 0, y, d / 2 - doorT / 2));
    leaf.add(box(inner - 0.02, fh * 0.6, cd * 0.8, wood, 0, y + 0.01, d / 2 - doorT - cd * 0.4));   // drawer box
    panel(leaf, w - 0.012, fh, 0, y, d / 2, face);
    leaf.add(handle(box(hl, 0.015, 0.02, metal, 0, y + fh * 0.6, d / 2 + 0.01), 0, y + fh * 0.6, d / 2 + 0.01, hl, false, s));
    g.add(slider(leaf, cd * 0.75));
  }
  const n = cfg.doors, yd = base + dz + 0.006, hd = h - base - dz - 0.012;
  const dw = (w - 0.006 * (n + 1)) / n;
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + 0.006 + dw / 2 + i * (dw + 0.006);
    const leaf = new THREE.Group();
    leaf.add(box(dw, hd, doorT, face, x, yd, d / 2 - doorT / 2));
    panel(leaf, dw, hd, x, yd, d / 2, face);
    const hx = n === 1 ? x + dw / 2 - 0.05 : x + (i % 2 === 0 ? 1 : -1) * (dw / 2 - 0.05);
    const hl = Math.min(0.35, hd * 0.2), hy = Math.max(yd + 0.05, base + h * 0.45);
    leaf.add(handle(box(0.015, hl, 0.02, metal, hx, hy, d / 2 + 0.01), hx, hy, d / 2 + 0.01, hl, true, s));
    if (openKind === 'slide') {
      // Sliding doors: every second door runs on the front rail over its neighbour.
      if (i % 2) g.add(slider(leaf, -dw, 'x', 'door')); else g.add(leaf);
      continue;
    }
    const left = n === 1 || i % 2 === 0;    // hinges opposite the handle
    g.add(hinged(leaf, left ? x - dw / 2 : x + dw / 2, d / 2 - doorT / 2, left ? -1 : 1));
  }
  return g;
}

function table(w, d, h, c, s) {
  const g = new THREE.Group();
  const wood = fm('wood', c, s);
  const top = Math.min(0.035, h * 0.1), lw = Math.min(0.06, w * 0.1, d * 0.1);
  g.add(box(w, top, d, wood, 0, h - top, 0));
  g.add(box(w - 0.1, 0.08, d - 0.1, wood, 0, h - top - 0.08, 0));            // apron
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * (w / 2 - lw / 2 - 0.03), z = sz * (d / 2 - lw / 2 - 0.03);
    g.add(leg(box(lw, h - top, lw, wood, x, 0, z), x, z, h - top, lw, c, s));
  }
  return g;
}

function sofa(w, d, h, c, s, seats) {
  const g = new THREE.Group();
  const fab = fm('fabric', c, s), dark = fm('dark', c, s);
  const legH = Math.min(0.08, h * 0.1), seatH = Math.min(0.45, h * 0.55);
  const arm = Math.min(0.18, w * 0.12), backD = Math.min(0.22, d * 0.25);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * (w / 2 - 0.06), z = sz * (d / 2 - 0.06);
    g.add(leg(taper(0.022, 0.014, legH, dark, x, 0, z), x, z, legH, 0.05, c, s));
  }
  const baseTop = legH + (seatH - legH) * 0.55;
  g.add(rbox(w, baseTop - legH, d, fab, 0, legH, 0, 0.03));                          // base
  g.add(rbox(w - 2 * arm + 0.04, h - baseTop, backD, fab, 0, baseTop, -d / 2 + backD / 2, 0.05)); // back
  const armH = Math.min(h, seatH + 0.2) - legH;
  for (const sx of [-1, 1]) g.add(rbox(arm, armH, d, fab, sx * (w / 2 - arm / 2), legH, 0, Math.min(0.06, arm * 0.4)));
  // Seat cushions and leaning back cushions.
  const n = seats || (w - 2 * arm > 1.6 ? 3 : 2);
  const cw = (w - 2 * arm) / n, sd = d - backD - 0.01;
  const bh = Math.min(0.42, h - seatH - 0.02);
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + arm + cw / 2 + i * cw;
    g.add(cushion(cw - 0.012, seatH - baseTop, sd, fab, x, baseTop, backD / 2));
    if (bh > 0.15 && sd > 0.35) {
      const b = cushion(cw - 0.03, bh, 0.16, fab, 0, -bh / 2, 0);
      const piv = new THREE.Group();
      piv.position.set(x, seatH + bh / 2 - 0.02, -d / 2 + backD + 0.07);
      piv.rotation.x = -0.18;
      piv.add(b);
      g.add(piv);
    }
  }
  return g;
}

function nightstand(w, d, h, c, s) {
  const g = new THREE.Group();
  const wood = fm('wood', c, s), metal = metalOf(c, s), dark = fm('dark', c, s);
  const legH = Math.min(0.08, h * 0.15);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * (w / 2 - 0.04), z = sz * (d / 2 - 0.04);
    g.add(leg(box(0.03, legH, 0.03, dark, x, 0, z), x, z, legH, 0.03, c, s));
  }
  g.add(box(w, h - legH, d - 0.015, wood, 0, legH, -0.0075));
  const n = cfg.drawers;
  const dh = (h - legH - 0.01 * (n + 1)) / n;
  for (let i = 0; i < n; i++) {
    const y = legH + 0.01 + i * (dh + 0.01);
    const face = fm('wood', c, s, 'facade'), leaf = new THREE.Group();
    leaf.add(box(w - 0.02, dh, 0.015, face, 0, y, d / 2 - 0.0075));
    leaf.add(box(w - 0.06, dh * 0.6, d * 0.7, wood, 0, y + 0.01, d / 2 - 0.015 - d * 0.35));   // drawer box
    panel(leaf, w - 0.02, dh, 0, y, d / 2, face);
    leaf.add(handle(cyl(0.012, 0.02, metal, 0, y + dh / 2 - 0.01, d / 2 + 0.005).rotateX(Math.PI / 2), 0, y + dh / 2 - 0.008, d / 2 + 0.01, 0.1, false, s));
    g.add(slider(leaf, d * 0.7));
  }
  return g;
}

function bed(w, d, h, c, s) {
  const g = new THREE.Group();
  const wood = fm('dark', c, s), soft = furnitureMat('soft', c, s), fab = fm('fabric', c, s);
  const frameH = Math.min(0.3, h * 0.55), matTop = Math.min(h - 0.02, frameH + 0.2);
  const head = Math.min(0.08, d * 0.06);
  g.add(rbox(w, frameH, d - head, wood, 0, 0, head / 2, 0.015));                    // frame
  g.add(rbox(w, h, head, wood, 0, 0, -d / 2 + head / 2, 0.02));                      // headboard (full height)
  if (h > matTop + 0.15) g.add(rbox(w - 0.08, h - matTop - 0.04, 0.05, fab, 0, matTop, -d / 2 + head + 0.025, 0.02));   // upholstered panel
  g.add(rbox(w - 0.04, matTop - frameH, d - head - 0.04, soft, 0, frameH, head / 2, 0.06)); // mattress
  // Pillows.
  const pn = w > 1.2 ? 2 : 1, pw = (w - 0.12) / pn;
  const ph = Math.min(0.12, Math.max(0.05, h - matTop));
  for (let i = 0; i < pn; i++) {
    g.add(cushion(pw - 0.05, ph, 0.38, soft, -w / 2 + 0.06 + pw / 2 + i * pw, matTop - 0.01, -d / 2 + head + 0.24));
  }
  // Duvet over the lower 65 % with its top edge folded back.
  const bl = (d - head) * 0.65;
  g.add(rbox(w + 0.02, 0.05, bl, fab, 0, matTop - 0.025, d / 2 - bl / 2 + 0.01, 0.022));
  g.add(rbox(w + 0.02, 0.03, 0.2, soft, 0, matTop + 0.02, d / 2 - bl + 0.1, 0.014));
  // The duvet hangs over the sides.
  for (const sx of [-1, 1]) g.add(box(0.012, Math.max(0.02, matTop - frameH), bl, fab, sx * (w / 2 + 0.006), frameH + 0.02, d / 2 - bl / 2 + 0.01));
  return g;
}

function chair(w, d, h, c, s) {
  const g = new THREE.Group();
  const wood = fm('wood', c, s), fab = fm('fabric', c, s);
  const seatH = Math.min(0.46, h * 0.5), leg = 0.035, seatT = 0.05;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const lh = sz < 0 ? h : seatH - seatT;                                     // back legs go up
    g.add(box(leg, lh, leg, wood, sx * (w / 2 - leg / 2), 0, sz * (d / 2 - leg / 2)));
  }
  g.add(box(w, seatT, d, fab, 0, seatH - seatT, 0));
  g.add(box(w - 2 * leg, Math.min(0.3, (h - seatH) * 0.6), 0.025, wood, 0, h - Math.min(0.3, (h - seatH) * 0.6) - 0.02, -d / 2 + leg / 2));
  return g;
}

function generic(w, d, h, c, s) {
  const g = new THREE.Group();
  g.add(box(w, h, d, fm('wood', c, s)));
  return g;
}

const armchair = (w, d, h, c, s) => sofa(w, d, h, c, s, 1);

// Carcass on short legs with a column of drawers (dresser, shoe cabinet, desk pedestal).
function drawers(w, d, h, c, s, rows) {
  const g = new THREE.Group();
  const wood = fm('wood', c, s), metal = metalOf(c, s), dark = fm('dark', c, s);
  const legH = cfg.bare ? 0 : Math.min(0.08, h * 0.1), front = 0.018, gap = 0.008;
  if (legH) for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * (w / 2 - 0.04), z = sz * (d / 2 - 0.04);
    g.add(leg(box(0.035, legH, 0.035, dark, x, 0, z), x, z, legH, 0.035, c, s));
  }
  g.add(box(w, h - legH, d - front, wood, 0, legH, -front / 2));
  const n = rows || cfg.drawers || Math.max(1, Math.round((h - legH) / 0.2));
  const fh = (h - legH - gap * (n + 1)) / n;
  for (let i = 0; i < n; i++) {
    const y = legH + gap + i * (fh + gap);
    const face = fm('wood', c, s, 'facade'), hl = Math.min(0.16, w * 0.3);
    const leaf = new THREE.Group();
    leaf.add(box(w - 2 * gap, fh, front, face, 0, y, d / 2 - front / 2));
    leaf.add(box(w - 0.06, fh * 0.6, d * 0.75, wood, 0, y + 0.01, d / 2 - front - d * 0.375));   // drawer box
    panel(leaf, w - 2 * gap, fh, 0, y, d / 2, face);
    leaf.add(handle(box(hl, 0.015, 0.02, metal, 0, y + fh * 0.6, d / 2 + 0.01), 0, y + fh * 0.6, d / 2 + 0.01, hl, false, s));
    g.add(slider(leaf, d * 0.75));
  }
  return g;
}

const dresser = (w, d, h, c, s) => drawers(w, d, h, c, s);
const shoerack = (w, d, h, c, s) => drawers(w, d, h, c, s);

// Low long cabinet: drawers on the sides, open niche in the middle.
function tvstand(w, d, h, c, s) {
  const g = new THREE.Group();
  const wood = fm('wood', c, s), dark = fm('dark', c, s);
  const side = Math.min(0.45, w * 0.3);
  g.add(drawers(side, d, h, c, s, 2).translateX(-w / 2 + side / 2));
  g.add(drawers(side, d, h, c, s, 2).translateX(w / 2 - side / 2));
  const mid = w - 2 * side, legH = cfg.bare ? 0 : Math.min(0.08, h * 0.1), t = 0.02;
  g.add(box(mid, t, d, wood, 0, legH, 0));                                    // bottom
  g.add(box(mid, t, d, wood, 0, h - t, 0));                                   // top
  g.add(box(mid, h - legH - 2 * t, 0.01, dark, 0, legH + t, -d / 2 + 0.005)); // back
  g.add(box(mid, t, d - 0.04, wood, 0, legH + (h - legH) / 2, -0.02));        // shelf
  return g;
}

// Open shelving with books (deterministic colours).
function bookshelf(w, d, h, c, s) {
  const g = new THREE.Group();
  const wood = fm('wood', c, s);
  const t = 0.02;
  g.add(box(t, h, d, wood, -w / 2 + t / 2, 0, 0));
  g.add(box(t, h, d, wood, w / 2 - t / 2, 0, 0));
  g.add(box(w - 2 * t, h, 0.008, wood, 0, 0, -d / 2 + 0.004));               // back
  const n = Math.max(2, Math.round(h / 0.38));
  const step = (h - t) / n;
  const colors = ['#8e3b46', '#2f5d8a', '#c9a227', '#3e7d4f', '#5b4a8a', '#d0d0d0', '#a0522d'];
  let k = 7;
  for (let i = 0; i <= n; i++) {
    const y = i * step;
    g.add(box(w - 2 * t, t, d - 0.01, wood, 0, y, 0.005));
    if (i === n) break;
    // Books, about 70 % of the shelf.
    let x = -w / 2 + t + 0.01;
    const maxX = w / 2 - t - (w - 2 * t) * 0.3;
    const bh0 = step - t - 0.03;
    while (x < maxX && bh0 > 0.08) {
      k = (k * 31 + 17) % 97;
      const bw = 0.02 + (k % 4) * 0.008, bh = Math.min(bh0, 0.18 + (k % 5) * 0.025);
      g.add(box(bw, bh, Math.min(0.22, d - 0.04), furnitureMat('plain', colors[k % colors.length], s), x + bw / 2, y + t, 0));
      x += bw + 0.002;
    }
  }
  return g;
}

// Table with a lower shelf.
function coffeetable(w, d, h, c, s) {
  const g = table(w, d, h, c, s);
  g.add(box(w - 0.1, 0.02, d - 0.1, fm('wood', c, s), 0, Math.min(0.12, h * 0.3), 0));
  return g;
}

// Desk: top, drawer pedestal on the right, panel leg on the left.
function desk(w, d, h, c, s) {
  const g = new THREE.Group();
  const wood = fm('wood', c, s);
  const top = 0.03, ped = Math.min(0.42, w * 0.35);
  g.add(box(w, top, d, wood, 0, h - top, 0));
  g.add(drawers(ped, d - 0.04, h - top, c, s, 3).translateX(w / 2 - ped / 2));
  g.add(box(0.025, h - top, d - 0.04, wood, -w / 2 + 0.0125, 0, 0));
  g.add(box(w - ped - 0.025, 0.25, 0.02, wood, -ped / 2, h - top - 0.25, -d / 2 + 0.03)); // modesty panel
  return g;
}

// Kitchen: base cabinets with countertop, sink and hob; wall cabinets if tall enough.
function kitchen(w, d, h, c, s) {
  const g = new THREE.Group();
  const front = fm('plain', c, s, 'facade'), body = fm('plain', c, s), metal = metalOf(c, s);
  const counter = furnitureMat('plain', '#5d5f63', s), dark = furnitureMat('plain', '#202124', s);
  const baseH = Math.min(0.86, h), plinth = 0.1, ct = 0.04;
  g.add(box(w, plinth, d - 0.06, dark, 0, 0, -0.03));
  g.add(box(w, baseH - plinth - ct, d - 0.04, body, 0, plinth, -0.02));
  const sw = Math.min(0.5, w * 0.25), sd = d * 0.6;
  g.add(slab(w, ct, d, counter, 0, baseH - ct, 0, { w: sw, d: sd, x: -w / 4, z: 0 }));
  const n = cfg.sections, dw = w / n;
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + dw / 2 + i * dw;
    const leaf = new THREE.Group();
    leaf.add(box(dw - 0.006, baseH - plinth - ct - 0.01, 0.018, front, x, plinth + 0.005, d / 2 - 0.029));
    panel(leaf, dw - 0.006, baseH - plinth - ct - 0.01, x, plinth + 0.005, d / 2 - 0.02, front);
    const hl = Math.min(0.2, dw * 0.5);
    leaf.add(handle(box(hl, 0.012, 0.02, metal, x, baseH - ct - 0.06, d / 2 - 0.01), x, baseH - ct - 0.06, d / 2 - 0.01, hl, false, s));
    const left = i % 2 === 0;
    g.add(hinged(leaf, left ? x - dw / 2 + 0.003 : x + dw / 2 - 0.003, d / 2 - 0.029, left ? -1 : 1));
  }
  g.add(sinkBowl(sw, sd, -w / 4, baseH, 0, s));
  g.add(tap(-w / 4, baseH, -d / 2 + 0.06, 0.28, s));
  g.add(hob(Math.min(0.58, w * 0.25), d * 0.85, w / 4, baseH, 0, s));
  if (h > 1.6) {
    const bottom = Math.max(baseH + 0.55, h - 0.75), ud = Math.min(0.35, d);
    g.add(box(w, h - bottom, ud, body, 0, bottom, -d / 2 + ud / 2));
    for (let i = 0; i < n; i++) {
      const x = -w / 2 + dw / 2 + i * dw;
      const hl = Math.min(0.2, dw * 0.5), z = -d / 2 + ud + 0.01;
      g.add(handle(box(hl, 0.012, 0.02, metal, x, bottom + 0.06, z), x, bottom + 0.06, z, hl, false, s));
    }
  }
  return g;
}

// Fridge: enamel body, freezer door at the bottom, vertical handles.
function fridge(w, d, h, c, s) {
  const g = new THREE.Group();
  const body = fm('plain', c, s), metal = metalOf(c, s);
  const door = 0.04, split = h * 0.36, lowH = Math.min(0.3, split * 0.6);
  g.add(box(w, h, d - door, body, 0, 0, -door / 2));
  const low = new THREE.Group(), up = new THREE.Group();
  low.add(box(w - 0.01, split - 0.01, door, body, 0, 0.005, d / 2 - door / 2));
  up.add(box(w - 0.01, h - split - 0.01, door, body, 0, split + 0.005, d / 2 - door / 2));
  low.add(box(0.02, lowH, 0.03, metal, w / 2 - 0.06, split - lowH - 0.05, d / 2 + 0.015));
  up.add(box(0.02, 0.35, 0.03, metal, w / 2 - 0.06, split + 0.08, d / 2 + 0.015));
  g.add(hinged(low, -w / 2 + 0.005, d / 2 - door / 2, -1), hinged(up, -w / 2 + 0.005, d / 2 - door / 2, -1));
  return g;
}

// ---- wall-mounted: built from the bottom (the item is lifted by elev in buildItem) ----

// Wall cabinet / mezzanine: carcass with 1–3 hinged doors and handles at the bottom edge.
function wallcabinet(w, d, h, c, s) {
  const g = new THREE.Group();
  const wood = fm('wood', c, s), metal = metalOf(c, s);
  const front = 0.018, gap = 0.004;
  g.add(box(w, h, d - front, wood, 0, 0, -front / 2));
  const n = Math.max(1, Math.min(3, Math.round(w / 0.45)));
  const dw = (w - gap * (n + 1)) / n;
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + gap + dw / 2 + i * (dw + gap);
    const face = fm('wood', c, s, 'facade'), hl = Math.min(0.12, dw * 0.4), leaf = new THREE.Group();
    leaf.add(box(dw, h - 2 * gap, front, face, x, gap, d / 2 - front / 2));
    panel(leaf, dw, h - 2 * gap, x, gap, d / 2, face);
    leaf.add(handle(box(hl, 0.012, 0.02, metal, x, gap + 0.03, d / 2 + 0.01), x, gap + 0.03, d / 2 + 0.01, hl, false, s));
    const left = n === 1 || i % 2 === 0;
    g.add(hinged(leaf, left ? x - dw / 2 : x + dw / 2, d / 2 - front / 2, left ? -1 : 1));
  }
  return g;
}
const mezzanine = wallcabinet;

// Floating shelf: a board with two hidden brackets.
function wallshelf(w, d, h, c, s) {
  const g = new THREE.Group();
  const wood = fm('wood', c, s), metal = metalOf(c, s);
  g.add(box(w, h, d, wood));
  for (const sx of [-1, 1]) g.add(box(0.02, 0.02, d * 0.8, metal, sx * w * 0.35, -0.02, -d * 0.1));
  return g;
}

// Floating TV console: long box with flap fronts and a dark gap line.
function tvpanel(w, d, h, c, s) {
  const g = new THREE.Group();
  const wood = fm('wood', c, s), dark = fm('dark', c, s);
  const front = 0.018;
  g.add(box(w, h, d - front, wood, 0, 0, -front / 2));
  const n = Math.max(2, Math.round(w / 0.6));
  const dw = (w - 0.004 * (n + 1)) / n;
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + 0.004 + dw / 2 + i * (dw + 0.004), face = fm('wood', c, s, 'facade');
    const leaf = new THREE.Group();
    leaf.add(box(dw, h - 0.008, front, face, x, 0.004, d / 2 - front / 2));
    panel(leaf, dw, h - 0.008, x, 0.004, d / 2, face);
    g.add(flap(leaf, 0.004, d / 2 - front / 2));
  }
  g.add(box(w * 0.98, 0.006, 0.002, dark, 0, h * 0.5, d / 2 + 0.001));
  return g;
}

// Wall mirror: thin frame with a reflective glass.
function mirror(w, d, h, c, s) {
  const g = new THREE.Group();
  const frame = furnitureMat('plain', c, s);
  const glass = new THREE.MeshStandardMaterial({ color: '#dfe7ef', roughness: 0.02, metalness: 1 });
  const f = Math.min(0.03, w * 0.08, h * 0.08);
  g.add(box(w, h, d * 0.6, frame, 0, 0, -d * 0.2));
  const m = box(w - 2 * f, h - 2 * f, 0.004, glass, 0, f, d * 0.1 + 0.002);
  g.add(m);
  return g;
}

// Glowing lamp shade: a cone open at both ends + a bulb light (power is set per scene by applyFixtures).
function lampHead(rTop, rBottom, hh, c, s, power) {
  const g = new THREE.Group();
  const shadeMat = furnitureMat('soft', c, s).clone();
  shadeMat.side = THREE.DoubleSide;
  shadeMat.emissive = new THREE.Color('#ffd9a0');
  shadeMat.emissiveIntensity = 0.35;
  shadeMat.userData.glow = 0.35;
  const shade = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, hh, 24, 1, true), shadeMat);
  shade.position.y = hh / 2;
  const light = new THREE.PointLight('#ffd9a8', power, 0, 2);
  light.position.y = hh * 0.4;
  light.userData.lampPower = power;
  g.add(shade, light);
  return g;
}

function floorlamp(w, d, h, c, s) {
  const g = new THREE.Group();
  const metal = metalOf(c, s);
  const r = Math.min(w, d) / 2;
  g.add(cyl(r * 0.6, 0.02, metal, 0, 0, 0));
  const hh = Math.min(0.32, h * 0.25);
  g.add(cyl(0.012, h - hh * 0.6, metal, 0, 0.02, 0));
  const head = lampHead(r * 0.55, r * 0.95, hh, c, s, 4);
  head.position.y = h - hh;
  g.add(head);
  return g;
}

function sconce(w, d, h, c, s) {
  const g = new THREE.Group();
  const metal = metalOf(c, s);
  // Back plate on the wall (-Z), arm forward, shade at the front.
  g.add(box(Math.min(0.1, w), Math.min(0.14, h), 0.02, metal, 0, h * 0.2, -d / 2 + 0.01));
  g.add(box(0.02, 0.02, d * 0.6, metal, 0, h * 0.35, -d / 2 + d * 0.3));
  const hh = h * 0.6;
  const rb = Math.min(w, d) * 0.45;   // the shade stays inside the footprint
  const head = lampHead(rb * 0.6, rb, hh, c, s, 2.5);
  head.position.set(0, h - hh, 0);
  g.add(head);
  return g;
}

// ---- shared parts (also used by models3dMore.js) ----

// Recessed bowl in a countertop / rim (sink, basin, bath): a hollow seen from above.
function sinkBowl(w, d, x, y, z, s, depth = 0.16, mat = furnitureMat('chrome', '', s)) {
  const g = new THREE.Group();
  const cav = new THREE.Mesh(new RoundedBoxGeometry(w, depth, d, 3, Math.min(0.04, w / 4, d / 4)), mat.clone());
  cav.material.side = THREE.BackSide;
  cav.position.set(x, y - depth / 2 + 0.002, z);
  cav.receiveShadow = true;
  g.add(cav);
  return g;
}

// Countertop slab (y = bottom) with an optional rectangular cut-out hole {w, d, x, z} for a bowl.
function slab(w, t, d, mat, x, y, z, hole) {
  if (!hole) return box(w, t, d, mat, x, y, z);
  const g = new THREE.Group(), hx0 = hole.x - hole.w / 2, hx1 = hole.x + hole.w / 2;
  const hz0 = hole.z - hole.d / 2, hz1 = hole.z + hole.d / 2;
  g.add(box(hx0 + w / 2, t, d, mat, x + (-w / 2 + hx0) / 2, y, z));          // left of the hole
  g.add(box(w / 2 - hx1, t, d, mat, x + (hx1 + w / 2) / 2, y, z));           // right of the hole
  g.add(box(hole.w, t, hz0 + d / 2, mat, x + hole.x, y, z + (-d / 2 + hz0) / 2)); // behind
  g.add(box(hole.w, t, d / 2 - hz1, mat, x + hole.x, y, z + (hz1 + d / 2) / 2));  // in front
  return g;
}

// Mixer tap: a column with a curved spout towards +Z.
function tap(x, y, z, h, s) {
  const g = new THREE.Group(), ch = furnitureMat('chrome', '', s);
  g.add(cyl(0.018, h * 0.6, ch, x, y, z));
  const arc = new THREE.Mesh(new THREE.TorusGeometry(h * 0.18, 0.011, 8, 16, Math.PI), ch);
  arc.rotation.y = -Math.PI / 2;
  arc.position.set(x, y + h * 0.6, z + h * 0.18);
  g.add(arc);
  g.add(box(0.012, 0.012, 0.07, ch, x, y + h * 0.42, z + 0.035));    // lever
  return g;
}

// Glass-ceramic hob with four burner rings.
function hob(w, d, x, y, z, s) {
  const g = new THREE.Group();
  g.add(box(w, 0.006, d, furnitureMat('screen', '', s), x, y, z));
  const ring = furnitureMat('plain', '#4a4d52', s);
  for (const [fx, fz, k] of [[-0.25, -0.22, 1], [0.25, -0.22, 0.75], [-0.25, 0.22, 0.75], [0.25, 0.22, 1]]) {
    const r = Math.min(w, d) * 0.17 * k;
    const t = new THREE.Mesh(new THREE.TorusGeometry(r, 0.004, 4, 32), ring);
    t.rotation.x = Math.PI / 2;
    t.position.set(x + fx * w, y + 0.007, z + fz * d);
    g.add(t);
  }
  return g;
}

export const conf = () => cfg;
export const style3d = () => sty;
export const look3d = () => look;
export const own3d = () => ownColor;
export const art3d = () => artName;
export { metalOf, box, slab, rbox, cyl, taper, cushion, fm, handle, leg, panel, hinged, flap, slider, sinkBowl, tap, hob, lampHead,
  wardrobe, drawers, wallcabinet, bed, sofa, table };

const BUILDERS = {
  ...MORE_BUILDERS,
  wardrobe, table, sofa, nightstand, bed, chair,
  armchair, dresser, shoerack, tvstand, bookshelf, coffeetable, desk, kitchen, fridge,
  wallcabinet, mezzanine, wallshelf, tvpanel, mirror, floorlamp, sconce
};

/**
 * Build a furniture object placed in the room.
 * @param item plan item (cm); status 'ok' | 'bad' | 'found'
 */
export function buildItem(item, status, materials = [], roomStyle, catalog = []) {
  look = itemLook(item, materials);
  ownColor = item.ownColor ? item.color : null;
  artName = item.art || null;
  sty = itemStyle(item, roomStyle);
  // Luxe collections have their own silhouettes; the other types keep the base model in collection materials.
  const make = (isLuxe(sty) && LUXE_BUILDERS[item.type]) || BUILDERS[item.type] || generic;
  preloadSets(packsOf(sty));      // luxe collections: their photo sets (downloaded on first use)
  movers = [];
  openKind = item.open?.kind || null;
  const spec = openSpec(item, catalog);
  cfg = {
    sections: sectionCount(item), drawers: drawerCount(item), bare: false,
    doors: openKind === 'slide' ? slideDoors(item) : spec.kind === 'swing' ? spec.doors : item.w > 160 ? 3 : item.w > 70 ? 2 : 1
  };
  const obj = dressed(make, item.type, item.w / 100, item.d / 100, item.h / 100, item.color, status);
  look = { body: null, facade: null };
  ownColor = null;
  artName = null;
  sty = 'modern';
  obj.userData.movers = movers;
  placeItem(obj, item);
  obj.userData.itemId = item.id;
  return obj;
}

/** Put a built model where the item stands on the plan (a move or a turn needs no new model). */
export function placeItem(obj, item) {
  const r = rectOf(item);
  obj.position.set((r.x + r.w / 2) / 100, (item.elev || 0) / 100, (r.y + r.h / 2) / 100);
  // Same direction as the 2D front marker: 0° → +Z (south), clockwise on the plan.
  obj.rotation.y = -item.rot * Math.PI / 180;
  obj.updateMatrixWorld(true);
}
