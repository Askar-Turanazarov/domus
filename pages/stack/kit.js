// The small toolkit of the tour: the language and its texts, SVG helpers, a packet that travels along a path, counters,
// "once on screen" and the source tooltip. Reduced motion: every wait is 0 and packets jump to the end.
import { T, LANGS } from './i18n.js';

export const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const NS = 'http://www.w3.org/2000/svg';
const listeners = new Set();
let lang = (() => { try { const l = localStorage.getItem('fsp3d.lang'); return LANGS.includes(l) ? l : 'ru'; } catch { return 'ru'; } })();

export const getLang = () => lang;
export const onLang = fn => listeners.add(fn);

export function t(key, vars) {
  const s = T[lang][key] ?? T.ru[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '') : s;
}

// Texts of the elements marked data-t (textContent, vars in data-tv), data-th (markup of our own dictionary),
// data-t-title, data-t-ph.
export function applyTexts(root = document) {
  for (const el of root.querySelectorAll('[data-t]')) el.textContent = t(el.dataset.t, el.dataset.tv ? JSON.parse(el.dataset.tv) : null);
  for (const el of root.querySelectorAll('[data-th]')) el.innerHTML = t(el.dataset.th);
  for (const el of root.querySelectorAll('[data-t-title]')) { el.title = t(el.dataset.tTitle); el.setAttribute('aria-label', el.title); }
  for (const el of root.querySelectorAll('[data-t-ph]')) el.placeholder = t(el.dataset.tPh);
}

export function setLang(l) {
  if (!LANGS.includes(l)) return;
  lang = l;
  try { localStorage.setItem('fsp3d.lang', l); } catch { /* storage unavailable */ }
  document.documentElement.lang = l;
  applyTexts();
  listeners.forEach(fn => fn(l));
}

export const wait = ms => new Promise(ok => setTimeout(ok, reduce ? 0 : ms));
export const ease = k => (k < .5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);

// One element from markup (our own strings only).
export function html(str) {
  const tpl = document.createElement('template');
  tpl.innerHTML = str.trim();
  return tpl.content.firstElementChild;
}
export function svgEl(tag, attrs = {}, parent = null) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}

// A node: a rounded box with one or two lines of text. → the <g>.
export function node(parent, { x, y, w, h, label, sub = null, cls = '', mono = false, rx = 10 }) {
  const g = svgEl('g', { class: `nd ${cls}` }, parent);
  svgEl('rect', { x: x - w / 2, y: y - h / 2, width: w, height: h, rx }, g);
  const main = svgEl('text', { x, y: sub ? y - 3 : y + 4.5, 'text-anchor': 'middle', class: `tx${mono ? ' mono' : ''}` }, g);
  if (label) main.dataset.t = label;
  if (sub) { const s = svgEl('text', { x, y: y + 13, 'text-anchor': 'middle', class: 'tx s' }, g); s.dataset.t = sub; }
  return g;
}

// A dot travelling along the path; removed at the end unless keep. → Promise (resolves at the end).
export function packet(path, { ms = 900, cls = '', r = 4.5, reverse = false, keep = false } = {}) {
  const svg = path.ownerSVGElement;
  const dot = svgEl('circle', { r, class: `pk ${cls}` }, svg);
  const len = path.getTotalLength();
  const at = k => { const p = path.getPointAtLength((reverse ? 1 - k : k) * len); dot.setAttribute('cx', p.x); dot.setAttribute('cy', p.y); };
  return new Promise(ok => {
    if (reduce) { at(1); if (!keep) dot.remove(); return ok(dot); }
    const t0 = performance.now();
    const step = now => {
      const k = Math.min(1, (now - t0) / ms);
      at(ease(k));
      if (k < 1) requestAnimationFrame(step);
      else { if (!keep) dot.remove(); ok(dot); }
    };
    at(0);
    requestAnimationFrame(step);
  });
}

// A path that draws itself when .on is added.
export function drawable(path) {
  const len = Math.ceil(path.getTotalLength());
  path.style.setProperty('--len', len);
  path.classList.add('draw');
  return path;
}

export function countUp(el, to, { ms = 1400, fmt = v => String(Math.round(v)) } = {}) {
  if (reduce) { el.textContent = fmt(to); return; }
  const t0 = performance.now();
  const step = now => {
    const k = Math.min(1, (now - t0) / ms);
    el.textContent = fmt(to * (1 - (1 - k) ** 3));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// fn once, the first time the element is on screen (and .in for the reveal styles).
export function onceVisible(el, fn, threshold = .25) {
  const io = new IntersectionObserver(entries => {
    if (!entries.some(e => e.isIntersecting)) return;
    io.disconnect();
    el.classList.add('in');
    fn?.();
  }, { threshold });
  io.observe(el);
}
// fn(true|false) whenever the element comes into or leaves the screen: loops run only while seen.
export function whileVisible(el, fn) {
  new IntersectionObserver(entries => fn(entries[entries.length - 1].isIntersecting), { threshold: .1 }).observe(el);
}

// The tooltip of the quality numbers: data-src (a file or a command) and data-tip (a dictionary key, optional).
let tip = null;
export function tipFor(el) {
  tip ??= document.body.appendChild(html('<div class="sk-tip" role="tooltip"></div>'));
  const show = () => {
    tip.innerHTML = '';
    if (el.dataset.tip) tip.append(t(el.dataset.tip), document.createElement('br'));
    tip.append(`${t('c9.src')}: `);
    const code = document.createElement('code');
    code.textContent = el.dataset.src;
    tip.append(code);
    const r = el.getBoundingClientRect();
    tip.style.left = `${Math.max(8, Math.min(innerWidth - 330, r.left))}px`;
    tip.style.top = `${r.bottom + 8 > innerHeight - 80 ? r.top - 60 : r.bottom + 8}px`;
    tip.classList.add('on');
  };
  const hide = () => tip.classList.remove('on');
  el.addEventListener('mouseenter', show);
  el.addEventListener('mouseleave', hide);
  el.addEventListener('focus', show);
  el.addEventListener('blur', hide);
  el.tabIndex = 0;
}
