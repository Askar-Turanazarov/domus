// The charts of the dashboard (12 §9.4): our own SVG, no library. Colours come from CSS classes (both themes), the numbers and labels from the caller,
// a tip on hover and on touch. Every function returns a <div class="dsh-chart"> with the svg and the tip; data goes in as text and numbers only.
const NS = 'http://www.w3.org/2000/svg';

function s(tag, attrs = {}, ...kids) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) e.setAttribute(k, String(v));
  e.append(...kids.flat().filter(k => k != null && k !== false));
  return e;
}

// A nice top of the scale: 1, 2, 2.5, 5 or 10 times a power of ten.
export function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v)), f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

// The frame of a chart: the svg, the tip. Targets carry data-tip="text"; the tip follows the pointer on hover and stays on touch until the next tap.
function frame(svg, label) {
  const tip = document.createElement('div');
  tip.className = 'dsh-tip';
  tip.hidden = true;
  const box = document.createElement('div');
  box.className = 'dsh-chart';
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  box.append(svg, tip);
  const show = e => {
    const target = e.target?.closest?.('[data-tip]');
    if (!target) { tip.hidden = true; return; }
    tip.textContent = target.getAttribute('data-tip');
    tip.hidden = false;
    const r = box.getBoundingClientRect?.();
    if (r && e.clientX != null) { tip.style.left = `${Math.max(0, Math.min(e.clientX - r.left + 10, r.width - 140))}px`; tip.style.top = `${Math.max(0, e.clientY - r.top - 34)}px`; }
  };
  box.addEventListener('pointerover', show);
  box.addEventListener('pointermove', show);
  box.addEventListener('click', show);
  box.addEventListener('pointerleave', () => { tip.hidden = true; });
  return box;
}

const W = 600, H = 220, PAD = { l: 44, r: 10, t: 12, b: 24 };
const X0 = PAD.l, X1 = W - PAD.r, Y0 = H - PAD.b, Y1 = PAD.t;

function axes(svg, { max, min = 0, fmt, labels, every }) {
  const y = v => Y0 - ((v - min) / (max - min)) * (Y0 - Y1);
  for (const v of [min, (min + max) / 2, max]) {
    svg.append(s('line', { x1: X0, x2: X1, y1: y(v), y2: y(v), class: v === 0 ? 'dsh-axis' : 'dsh-grid' }),
      s('text', { x: X0 - 6, y: y(v) + 4, class: 'dsh-tick', 'text-anchor': 'end' }, fmt(v)));
  }
  if (min < 0) svg.append(s('line', { x1: X0, x2: X1, y1: y(0), y2: y(0), class: 'dsh-axis' }));
  const n = labels.length, step = (X1 - X0) / n;
  labels.forEach((l, i) => { if (i % every === 0) svg.append(s('text', { x: X0 + step * (i + 0.5), y: H - 6, class: 'dsh-tick', 'text-anchor': 'middle' }, l)); });
  return y;
}

// Bars, one per point: points — [{ label, value, tip }]; fmt — the axis format of a value. A negative value goes below the zero line.
export function barChart(points, { fmt = String, every = 1, label = '' } = {}) {
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'dsh-svg' });
  const values = points.map(p => p.value);
  const max = niceMax(Math.max(0, ...values)), min = Math.min(0, ...values) < 0 ? -niceMax(-Math.min(...values)) : 0;
  const y = axes(svg, { max, min, fmt, labels: points.map(p => p.label), every });
  const step = (X1 - X0) / Math.max(1, points.length), bw = Math.max(2, step * 0.62);
  points.forEach((p, i) => {
    const x = X0 + step * i + (step - bw) / 2, top = Math.min(y(p.value), y(0)), h = Math.abs(y(p.value) - y(0));
    svg.append(s('rect', { x, y: top, width: bw, height: Math.max(p.value ? 1 : 0, h), rx: 2, class: 'dsh-bar' + (p.value < 0 ? ' neg' : '') }),
      s('rect', { x: X0 + step * i, y: Y1, width: step, height: Y0 - Y1, class: 'dsh-hit', 'data-tip': p.tip }));
  });
  return frame(svg, label);
}

// Lines with dots: series — [{ key, name, values }] over the same labels; tips — [text] per x (all series of the point together).
export function lineChart(labels, series, { tips = [], every = 1, label = '' } = {}) {
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'dsh-svg' });
  const max = niceMax(Math.max(0, ...series.flatMap(l => l.values)));
  const y = axes(svg, { max, fmt: v => String(Math.round(v * 10) / 10), labels, every });
  const step = (X1 - X0) / Math.max(1, labels.length), x = i => X0 + step * (i + 0.5);
  for (const line of series) {
    const d = line.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
    svg.append(s('path', { d, class: `dsh-line ${line.key}` }));
    if (labels.length <= 31) line.values.forEach((v, i) => svg.append(s('circle', { cx: x(i), cy: y(v), r: 3, class: `dsh-dot ${line.key}` })));
  }
  labels.forEach((_, i) => svg.append(s('rect', { x: X0 + step * i, y: Y1, width: step, height: Y0 - Y1, class: 'dsh-hit', 'data-tip': tips[i] ?? '' })));
  return frame(svg, label);
}

// Horizontal stacks: rows — [{ label, parts: [{ key, value, name }] }]; every part is a segment `seg-<key>`, the tip lists the parts of the row.
export function stackBars(rows, { label = '' } = {}) {
  const rowH = 30, h = rows.length * rowH + 8, left = 70, right = 40;
  const svg = s('svg', { viewBox: `0 0 ${W} ${h}`, class: 'dsh-svg dsh-stack' });
  const total = Math.max(1, ...rows.map(r => r.parts.reduce((a, p) => a + p.value, 0)));
  rows.forEach((r, i) => {
    const yy = 4 + i * rowH, sum = r.parts.reduce((a, p) => a + p.value, 0), tip = `${r.label}: ${r.parts.map(p => `${p.name} ${p.value}`).join(' · ')}`;
    svg.append(s('text', { x: left - 8, y: yy + 17, class: 'dsh-tick', 'text-anchor': 'end' }, r.label));
    let x = left;
    for (const p of r.parts) {
      const w = (p.value / total) * (W - left - right);
      if (w > 0) svg.append(s('rect', { x, y: yy + 4, width: w, height: 18, class: `dsh-seg seg-${p.key}` }));
      x += w;
    }
    svg.append(s('text', { x: x + 6, y: yy + 17, class: 'dsh-tick' }, String(sum)), s('rect', { x: 0, y: yy, width: W, height: rowH, class: 'dsh-hit', 'data-tip': tip }));
  });
  return frame(svg, label);
}
