// The stack tour (/stack): the shell — top bar links, language, theme, the chapter nav and progress, the hero — and the ten
// scenes (scenes-a.js, scenes-b.js). Each scene builds itself once and starts the first time it is on screen.
import { initTheme } from '/js/theme.js';
import { getLang, setLang, onLang, applyTexts, html, svgEl, countUp, onceVisible } from './kit.js';
import { scene1, scene2, scene3, scene4, scene5 } from './scenes-a.js';
import { scene6, scene7, scene8, scene9, scene10 } from './scenes-b.js';

const SCENES = [scene1, scene2, scene3, scene4, scene5, scene6, scene7, scene8, scene9, scene10];

function topBar() {
  const sync = () => {
    for (const a of document.querySelectorAll('[data-href]')) a.href = `/${getLang()}${a.dataset.href}`;
    for (const b of document.querySelectorAll('[data-lang]')) b.classList.toggle('active', b.dataset.lang === getLang());
  };
  for (const b of document.querySelectorAll('[data-lang]')) b.addEventListener('click', () => setLang(b.dataset.lang));
  onLang(sync);
  sync();
  document.getElementById('skOut').addEventListener('click', async () => {
    await fetch('/api/stack/logout', { method: 'POST', headers: { 'X-Requested-With': 'domus-stack' } }).catch(() => {});
    location.reload();
  });
  initTheme();
}

// The hero picture: the layers of the system settle onto each other; the core layer is the gold one.
function heroArt() {
  const layers = ['Browser · 3D', 'Telegram · MCP', 'AI agents · RAG', 'Core', 'PostgreSQL'];
  const svg = svgEl('svg', { viewBox: '0 0 420 400', role: 'img' });
  svgEl('ellipse', { cx: 210, cy: 236, rx: 190, ry: 90, class: 'hl-glow' }, svg);
  layers.forEach((name, i) => {
    const y = 40 + i * 62;
    const g = svgEl('g', { class: `hl${name === 'Core' ? ' gold' : ''}`, style: `--i:${layers.length - 1 - i}` }, svg);
    // an isometric plate: top face, two sides
    svgEl('path', { class: 'side', d: `M60 ${y + 50} L210 ${y + 100} L210 ${y + 112} L60 ${y + 62} Z` }, g);
    svgEl('path', { class: 'side2', d: `M210 ${y + 100} L360 ${y + 50} L360 ${y + 62} L210 ${y + 112} Z` }, g);
    svgEl('path', { class: 'top', d: `M210 ${y} L360 ${y + 50} L210 ${y + 100} L60 ${y + 50} Z` }, g);
    const tx = svgEl('text', { x: 210, y: y + 54, 'text-anchor': 'middle' }, g);
    tx.textContent = name;
  });
  document.getElementById('heroArt').appendChild(svg);
}

function chapters() {
  const host = document.getElementById('skChapters'), nav = document.getElementById('skNav');
  SCENES.forEach((scene, i) => {
    const n = i + 1, id = `c${n}`;
    const sec = html(`<section class="sk-ch" id="${id}" aria-labelledby="${id}t">
      <div class="sk-ch-head sk-rv"><div class="sk-no">${String(n).padStart(2, '0')}</div><h3 id="${id}t" data-t="${id}.title"></h3><p class="sk-lead" data-t="${id}.lead"></p></div>
      <div class="sk-body sk-rv" style="--d:150ms"></div></section>`);
    host.appendChild(sec);
    nav.appendChild(html(`<a href="#${id}" data-ch="${id}"><b>${String(n).padStart(2, '0')}</b><i></i><span data-t="nav.${n}"></span></a>`));
    const api = scene(sec.querySelector('.sk-body'), sec) || {};
    applyTexts(sec);
    onceVisible(sec, () => api.start?.(), .2);
  });
  // the nav follows the chapter in the middle of the screen
  const links = [...nav.querySelectorAll('a')];
  const io = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) links.forEach(a => a.classList.toggle('on', a.dataset.ch === e.target.id));
  }, { rootMargin: '-45% 0px -50% 0px' });
  host.querySelectorAll('.sk-ch').forEach(s => io.observe(s));
}

function progress() {
  const bar = document.getElementById('skProgress');
  const update = () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    bar.style.width = `${max > 0 ? Math.min(100, (scrollY / max) * 100) : 0}%`;
  };
  addEventListener('scroll', update, { passive: true });
  addEventListener('resize', update);
  update();
}

topBar();
document.documentElement.lang = getLang();
heroArt();
chapters();
applyTexts();
progress();
const hero = document.getElementById('hero');
onceVisible(hero, () => hero.querySelectorAll('[data-count]').forEach(b => countUp(b, Number(b.dataset.count))), .1);
