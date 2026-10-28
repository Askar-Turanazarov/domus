// Canvases for the lobby paintings (item.art): drawn in code, no image files. Registan at dusk, a suzani
// medallion, adras and khan-atlas ikat. Each texture is drawn once and cached.
import * as THREE from 'three';

const cache = new Map();

// Deterministic noise so every visit shows the same picture.
function rng(seed) {
  let k = seed >>> 0;
  return () => ((k = (k * 1103515245 + 12345) >>> 0) / 4294967296);
}

// Registan: three madrasahs (Ulugbek, Tilya-Kori, Sher-Dor) with portals, domes and minarets against the sky.
function registan(g, W, H) {
  const sky = g.createLinearGradient(0, 0, 0, H * 0.75);
  sky.addColorStop(0, '#22345e'); sky.addColorStop(0.55, '#c8706a'); sky.addColorStop(1, '#f2c27a');
  g.fillStyle = sky; g.fillRect(0, 0, W, H);
  g.fillStyle = '#d9b98a'; g.fillRect(0, H * 0.8, W, H * 0.2);                // the square
  g.fillStyle = 'rgba(80,50,30,.25)';
  for (let x = 0; x < W; x += 24) g.fillRect(x, H * 0.8, 1, H * 0.2);
  const brick = '#c99a62', tile = '#1f6fa8', turq = '#3bb2b8';
  const building = (cx, w, h, dome) => {
    const base = H * 0.8, top = base - h;
    g.fillStyle = brick; g.fillRect(cx - w / 2, top + h * 0.25, w, h * 0.75);     // the wings
    const pw = w * 0.42;                                                           // the portal (pishtaq)
    g.fillRect(cx - pw / 2, top, pw, h);
    g.fillStyle = tile;
    g.fillRect(cx - pw / 2 + 4, top + 4, pw - 8, h * 0.12);
    g.beginPath();                                                                 // the pointed arch
    const aw = pw * 0.56, ab = base, at = top + h * 0.22;
    g.moveTo(cx - aw / 2, ab); g.lineTo(cx - aw / 2, at + aw * 0.45);
    g.quadraticCurveTo(cx - aw / 2, at, cx, at - aw * 0.12);
    g.quadraticCurveTo(cx + aw / 2, at, cx + aw / 2, at + aw * 0.45);
    g.lineTo(cx + aw / 2, ab); g.closePath(); g.fill();
    g.fillStyle = '#16314f';
    g.fillRect(cx - aw * 0.3, at + aw * 0.35, aw * 0.6, ab - at - aw * 0.35);
    g.fillStyle = turq;                                                            // rows of tiled niches on the wings
    for (const s of [-1, 1]) {
      for (let i = 0; i < 2; i++) {
        const nx = cx + s * (pw / 2 + 6 + i * (w - pw) / 4.4);
        for (const ny of [top + h * 0.38, top + h * 0.62]) g.fillRect(s > 0 ? nx : nx - (w - pw) / 6, ny, (w - pw) / 6, h * 0.14);
      }
    }
    for (const s of [-1, 1]) {                                                     // minarets
      const mx = cx + s * (w / 2 - 5);
      g.fillStyle = brick; g.fillRect(mx - 5, top - h * 0.18, 10, h * 1.18);
      g.fillStyle = tile; g.fillRect(mx - 6, top - h * 0.18, 12, 6);
    }
    if (dome) {
      g.fillStyle = turq;
      g.beginPath(); g.ellipse(cx + w * 0.3, top + h * 0.22, w * 0.11, h * 0.2, 0, Math.PI, 0); g.fill();
      g.fillStyle = brick; g.fillRect(cx + w * 0.19, top + h * 0.22, w * 0.22, h * 0.05);
    }
  };
  building(W * 0.18, W * 0.3, H * 0.42, false);
  building(W * 0.5, W * 0.34, H * 0.46, true);
  building(W * 0.82, W * 0.3, H * 0.42, true);
}

// Suzani: a red medallion with petals on a cream ground, a border of buds.
function suzani(g, W, H) {
  g.fillStyle = '#efe4cc'; g.fillRect(0, 0, W, H);
  g.strokeStyle = '#8c1c24'; g.lineWidth = W * 0.04; g.strokeRect(W * 0.04, H * 0.04, W * 0.92, H * 0.92);
  const r = rng(11);
  for (let i = 0; i < 28; i++) {                                                   // the border buds
    const t = i / 28, side = Math.floor(t * 4), f = (t * 4) % 1;
    const x = [W * (0.1 + f * 0.8), W * 0.9, W * (0.9 - f * 0.8), W * 0.1][side];
    const y = [H * 0.1, H * (0.1 + f * 0.8), H * 0.9, H * (0.9 - f * 0.8)][side];
    g.fillStyle = i % 2 ? '#c2412d' : '#2f5d3a';
    g.beginPath(); g.arc(x, y, W * 0.025, 0, Math.PI * 2); g.fill();
  }
  const cx = W / 2, cy = H / 2;
  const ring = (n, rad, len, col, w) => {
    g.fillStyle = col;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      g.save(); g.translate(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad); g.rotate(a);
      g.beginPath(); g.ellipse(0, 0, len, w, 0, 0, Math.PI * 2); g.fill(); g.restore();
    }
  };
  g.fillStyle = '#b3242c'; g.beginPath(); g.arc(cx, cy, W * 0.3, 0, Math.PI * 2); g.fill();
  ring(16, W * 0.3, W * 0.06, '#b3242c', W * 0.03);
  ring(12, W * 0.22, W * 0.05, '#e9a23b', W * 0.022);
  g.fillStyle = '#5b1a4a'; g.beginPath(); g.arc(cx, cy, W * 0.15, 0, Math.PI * 2); g.fill();
  ring(8, W * 0.1, W * 0.035, '#efe4cc', W * 0.016);
  g.fillStyle = '#e9a23b'; g.beginPath(); g.arc(cx, cy, W * 0.045, 0, Math.PI * 2); g.fill();
  for (const [x, y] of [[0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]]) {          // corner rosettes
    g.fillStyle = '#2f5d3a'; g.beginPath(); g.arc(W * x, H * y, W * 0.05, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#c2412d'; g.beginPath(); g.arc(W * x, H * y, W * 0.025 + r() * 2, 0, Math.PI * 2); g.fill();
  }
}

// Ikat (abrbandi): vertical bands of stepped diamonds with the soft, blurred edges of tie-dyed warp.
function ikat(colors) {
  return (g, W, H) => {
    g.fillStyle = colors[0]; g.fillRect(0, 0, W, H);
    const r = rng(colors.join('').length * 97);
    const cols = 3, cw = W / cols;
    for (let c = 0; c < cols; c++) {
      const cx = cw * (c + 0.5), step = H / 5;
      for (let k = 0; k < 6; k++) {
        const cy = step * k + (c % 2 ? step / 2 : 0);
        for (let layer = 0; layer < 3; layer++) {
          const s = 1 - layer * 0.3;
          g.fillStyle = colors[1 + ((k + layer + c) % (colors.length - 1))];
          g.beginPath();
          // stepped diamond, each row shifted a little like hand-tied threads
          for (let i = 0; i <= 16; i++) {
            const a = (i / 16) * Math.PI * 2, rx = cw * 0.46 * s, ry = step * 0.48 * s;
            const x = cx + Math.sign(Math.cos(a)) * Math.abs(Math.cos(a)) ** 1.6 * rx + (r() - 0.5) * 6;
            const y = cy + Math.sign(Math.sin(a)) * Math.abs(Math.sin(a)) ** 1.6 * ry;
            i ? g.lineTo(x, y) : g.moveTo(x, y);
          }
          g.closePath(); g.fill();
        }
      }
    }
    g.globalAlpha = 0.18;                                                          // the feathered warp edges
    for (let x = 0; x < W; x += 2) { g.fillStyle = r() > 0.5 ? '#fff' : '#000'; g.fillRect(x, 0, 1, H); }
    g.globalAlpha = 1;
  };
}

const DRAW = {
  registan: [512, 256, registan],
  suzani: [256, 256, suzani],
  adras: [192, 320, ikat(['#f3e7c9', '#c0262d', '#f0b429', '#2d6a4f', '#5b2a86'])],
  atlas: [192, 320, ikat(['#1d2f6f', '#e63946', '#f1c40f', '#f8f1e5', '#2a9d8f'])]
};

/** The texture of a named painting, or null for an unknown name (the abstract canvas is used then). */
export function artTexture(name) {
  if (!DRAW[name]) return null;
  if (cache.has(name)) return cache.get(name);
  const [W, H, draw] = DRAW[name];
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  draw(cv.getContext('2d'), W, H);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  cache.set(name, tex);
  return tex;
}
