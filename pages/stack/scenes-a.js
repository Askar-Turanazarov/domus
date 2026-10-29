// Scenes 1–5 of the stack tour: one core, 3D, the booking race, payments, the agents.
import { t, getLang, onLang, reduce, wait, html, svgEl, node, packet, drawable, countUp, whileVisible } from './kit.js';

const chips = list => `<div class="sk-chips">${list.map(c => `<span class="sk-chip">${c}</span>`).join('')}</div>`;
function txt(parent, x, y, key, cls = 'tx', anchor = 'middle') {
  const el = svgEl('text', { x, y, 'text-anchor': anchor, class: cls }, parent);
  if (key) { el.dataset.t = key; el.textContent = t(key); }
  return el;
}
function arrowDefs(svg, id, color = 'var(--line-2)') {
  const defs = svgEl('defs', {}, svg);
  const m = svgEl('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, defs);
  svgEl('path', { d: 'M0 1 L9 5 L0 9', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, style: `stroke:${color}` }, m);
  return `url(#${id})`;
}
const restart = (el, cls) => { el.classList.remove(cls); el.getBoundingClientRect(); el.classList.add(cls); };

// ---------- 1. One core — six entrances ----------
export function scene1(body) {
  body.innerHTML = `<div class="sk-stage"><svg viewBox="0 0 900 440" aria-hidden="true"></svg><div class="c1-detail" aria-live="polite"></div></div>
    <div class="sk-hint" data-t="c1.hint"></div>${chips(['Node.js 24', 'Express', 'PostgreSQL · Neon', 'PGlite', 'Vercel', 'Outbox', 'QStash'])}`;
  const svg = body.querySelector('svg'), detail = body.querySelector('.c1-detail');
  const C = { x: 450, y: 200 }, R = 72;
  const ENTRIES = [['web', 130, 70, -1], ['chat', 130, 200, -1], ['tg', 130, 330, -1], ['mini', 770, 70, 1], ['admin', 770, 200, 1], ['mcp', 770, 330, 1]];

  svgEl('circle', { cx: C.x, cy: C.y, r: 94, class: 'ln dash c1-orbit' }, svg);
  const paths = ENTRIES.map(([, x, y, side]) => {
    const x0 = x - side * 95, x1 = C.x + side * R, mx = (x0 + x1) / 2;
    return svgEl('path', { class: 'ln', d: `M${x0} ${y} C${mx} ${y} ${mx} ${C.y} ${x1} ${C.y}` }, svg);
  });
  const toDb = svgEl('path', { class: 'ln', d: 'M450 272 C450 322 360 330 360 380' }, svg);
  const toOut = svgEl('path', { class: 'ln', d: 'M450 272 C450 322 540 330 540 380' }, svg);
  const pulse = svgEl('circle', { cx: C.x, cy: C.y, r: R, class: 'c1-core-pulse' }, svg);
  const core = svgEl('g', { class: 'nd hot' }, svg);
  svgEl('circle', { cx: C.x, cy: C.y, r: R, class: 'box' }, core);
  txt(core, C.x, C.y + 4, 'c1.core', 'tx big');
  txt(core, C.x, C.y + 26, null, 'tx mono').textContent = 'server/core';
  txt(svg, C.x, 112, 'c1.coreSub', 'tx xs');
  node(svg, { x: 360, y: 402, w: 160, h: 40, label: 'c1.db' });
  node(svg, { x: 545, y: 402, w: 170, h: 40, label: 'c1.outbox' });
  const nodes = ENTRIES.map(([k, x, y]) => node(svg, { x, y, w: 190, h: 50, label: `c1.${k}`, cls: 'click' }));

  let seen = false, hot = -1;
  const flow = async i => {
    await packet(paths[i], { ms: 1000 });
    restart(pulse, 'go');
    packet(toDb, { ms: 700 });
    if (i < 3) packet(toOut, { ms: 850 });
  };
  const select = i => {
    hot = i;
    nodes.forEach((n, j) => { n.classList.toggle('hot', j === i); n.classList.toggle('dim', i >= 0 && j !== i); });
    paths.forEach((p, j) => { p.classList.toggle('hot', j === i); p.classList.toggle('dim', i >= 0 && j !== i); });
    if (i >= 0) { detail.dataset.t = `c1.d.${ENTRIES[i][0]}`; detail.textContent = t(detail.dataset.t); } else { delete detail.dataset.t; detail.textContent = ''; }
  };
  nodes.forEach((n, i) => {
    n.addEventListener('mouseenter', () => { select(i); flow(i); });
    n.addEventListener('mouseleave', () => select(-1));
    n.addEventListener('click', () => { select(i); flow(i); });
  });
  whileVisible(body, v => { seen = v; });
  return {
    async start() {
      if (reduce) return;
      for (let i = 0; i < 6; i++) { packet(paths[i], { ms: 1100 }); await wait(160); }
      for (;;) {
        await wait(1700);
        if (!seen) continue;
        if (hot >= 0) flow(hot); else flow(Math.floor(Math.random() * 6));
      }
    }
  };
}

// ---------- 2. 3D ----------
export function scene2(body) {
  body.innerHTML = `<div class="sk-stage"><div class="c2-wrap">
      <div class="c2-left"><div class="c2-screen"><div class="c2-poster"><svg viewBox="0 0 640 360" preserveAspectRatio="xMidYMid slice" aria-hidden="true"></svg>
        <div class="c2-cta"><div class="sk-row" style="margin:0;justify-content:center"><button class="sk-btn primary" data-go="building" data-t="c2.enter"></button><button class="sk-btn" data-go="apt" data-t="c2.apt"></button></div>
        <div class="c2-lazy" data-t="c2.lazy"></div></div></div>
        </div><div class="c2-bar"><button class="sk-btn c2-close" data-t="c2.close"></button></div></div>
      <div class="c2-facts">${[[92, 'c2.f1'], [12, 'c2.f2'], [41, 'c2.f3'], [3, 'c2.f4']].map(([n, k]) => `<div><b data-n="${n}">0</b><span data-t="${k}"></span></div>`).join('')}</div>
    </div><div class="sk-how" data-t="c2.how"></div></div>${chips(['three.js', 'WebGL', 'ES modules', 'CC0 textures', 'walk map'])}`;
  const screen = body.querySelector('.c2-screen'), svg = body.querySelector('svg');
  // the poster: the building at dusk, its windows light up one by one
  const defs = svgEl('defs', {}, svg);
  const g = svgEl('linearGradient', { id: 'c2sky', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  svgEl('stop', { offset: 0, 'stop-color': '#0b0b0d' }, g);
  svgEl('stop', { offset: 1, 'stop-color': '#241f17' }, g);
  svgEl('rect', { width: 640, height: 360, fill: 'url(#c2sky)' }, svg);
  svgEl('path', { d: 'M222 70 L420 70 L452 86 L452 330 L420 330 L222 330 Z', fill: '#151412', stroke: 'rgba(201,169,110,.25)' }, svg);
  svgEl('path', { d: 'M420 70 L452 86 L452 330 L420 330 Z', fill: '#0f0e0d' }, svg);
  const wins = [];
  for (let f = 0; f < 12; f++) for (let c = 0; c < 8; c++) {
    wins.push(svgEl('rect', { x: 234 + c * 23, y: 82 + f * 20, width: 13, height: 10, rx: 1, class: 'win' }, svg));
  }
  svgEl('rect', { x: 0, y: 330, width: 640, height: 30, fill: '#0d0c0b' }, svg);
  svgEl('line', { x1: 0, y1: 330, x2: 640, y2: 330, stroke: 'rgba(201,169,110,.3)' }, svg);
  wins.forEach((w, i) => { if ((i * 37) % 11 < 3) w.classList.add('lit'); });

  // the scene takes the language from ?lang=: a switch on this page reopens it in the new one
  let open = null;
  const close = () => { screen.querySelector('iframe')?.remove(); body.classList.remove('c2-live'); screen.classList.remove('live'); open = null; };
  const show = go => {
    close();
    const src = go === 'apt' ? `/index.html?embed=floor&b=chinor-park&apt=41&lang=${getLang()}`
      : `/index.html?embed=building&b=chinor-park&floor=1&from=street&lang=${getLang()}`;
    const f = html(`<iframe title="3D" allow="fullscreen" loading="eager"></iframe>`);
    f.src = src;
    f.addEventListener('load', () => f.classList.add('on'));
    screen.prepend(f);
    screen.classList.add('live');
    body.classList.add('c2-live');
    open = go;
  };
  for (const b of body.querySelectorAll('[data-go]')) b.addEventListener('click', () => show(b.dataset.go));
  body.querySelector('.c2-close').addEventListener('click', close);
  onLang(() => { if (open) show(open); });

  let seen = false;
  whileVisible(body, v => { seen = v; });
  return {
    async start() {
      body.querySelectorAll('[data-n]').forEach(b => countUp(b, Number(b.dataset.n)));
      if (reduce) return;
      for (;;) {
        await wait(1400);
        if (!seen || screen.classList.contains('live')) continue;
        wins[Math.floor(Math.random() * wins.length)].classList.toggle('lit');
      }
    }
  };
}

// ---------- 3. The booking race ----------
export function scene3(body) {
  body.innerHTML = `<div class="sk-stage"><span class="sk-sim" data-t="sim"></span><div class="c3-grid">
      <svg class="c3-sm" viewBox="0 0 900 250" aria-hidden="true"></svg>
      <div class="c3-race"><div class="sk-row"><button class="sk-btn primary" data-t="c3.race"></button><span class="c3-res grow"></span></div>
      <svg class="c3-rc" viewBox="0 0 900 190" aria-hidden="true"></svg></div></div>
      <div class="sk-how" data-t="c3.how"></div><div class="sk-proof" data-t="c3.neon"></div></div>
      ${chips(['SELECT … FOR UPDATE', 'unique index', 'Idempotency-Key', 'clock.now()', 'jobs + QStash'])}`;
  const sm = body.querySelector('.c3-sm'), rc = body.querySelector('.c3-rc');
  const ar = arrowDefs(sm, 'c3ar');
  const S = [['free', 100], ['held', 330], ['booked', 570], ['converted', 800]];
  const links = [];
  for (let i = 0; i < 3; i++) links.push(svgEl('path', { class: 'ln', d: `M${S[i][1] + 76} 90 L${S[i + 1][1] - 78} 90`, 'marker-end': ar }, sm));
  const lostA = svgEl('path', { class: 'ln dash', d: 'M330 118 C330 170 380 200 420 205' }, sm);
  const lostB = svgEl('path', { class: 'ln dash', d: 'M570 118 C570 170 520 200 480 205' }, sm);
  svgEl('path', { class: 'ln dash', d: 'M320 212 C200 222 110 190 100 120', 'marker-end': ar }, sm);
  const states = S.map(([k, x]) => node(sm, { x, y: 90, w: 152, h: 56, label: `c3.${k}`, sub: k === 'held' ? 'c3.heldT' : k === 'booked' ? 'c3.bookedT' : null }));
  node(sm, { x: 450, y: 210, w: 300, h: 34, label: 'c3.lost', cls: 'dim' });
  // the hold timer: a ring that drains while the token sits in «held»
  svgEl('circle', { cx: 398, cy: 62, r: 12, class: 'ring-bg' }, sm);
  const ring = svgEl('circle', { cx: 398, cy: 62, r: 12, class: 'ring', 'stroke-dasharray': 75.4, 'stroke-dashoffset': 0, transform: 'rotate(-90 398 62)' }, sm);
  const clock = txt(sm, 398, 36, null, 'tx xs');
  clock.textContent = '15:00';
  const dep = txt(sm, 570, 150, 'c3.deposit', 'tx s g fade');

  const show = i => states.forEach((s, j) => s.classList.toggle('hot', j === i));
  const drain = ms => new Promise(ok => {
    if (reduce) { ring.setAttribute('stroke-dashoffset', 0); return ok(); }
    const t0 = performance.now();
    const step = now => {
      const k = Math.min(1, (now - t0) / ms);
      ring.setAttribute('stroke-dashoffset', 75.4 * k);
      const left = Math.round(900 * (1 - k));
      clock.textContent = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
      if (k < 1) requestAnimationFrame(step); else ok();
    };
    requestAnimationFrame(step);
  });
  let seen = false;
  whileVisible(body, v => { seen = v; });
  const cycle = async () => {
    show(0); await wait(1100);
    await packet(links[0], { ms: 700 }); show(1);
    await drain(2600);
    await packet(links[1], { ms: 700 }); show(2); dep.classList.add('on');
    await wait(1500);
    await packet(links[2], { ms: 700 }); show(3);
    await wait(1600);
    dep.classList.remove('on'); ring.setAttribute('stroke-dashoffset', 0); clock.textContent = '15:00';
  };

  // the race: two buyers press at the same moment, the row lock lets one through
  const A = { x: 90 }, B = { x: 810 };
  const pa = svgEl('path', { class: 'ln', d: 'M130 95 L388 95' }, rc), pb = svgEl('path', { class: 'ln', d: 'M770 95 L512 95' }, rc);
  for (const [p, k] of [[A, 'c3.a'], [B, 'c3.b']]) {
    const gg = svgEl('g', { class: 'nd' }, rc);
    svgEl('circle', { cx: p.x, cy: 95, r: 30, class: 'box' }, gg);
    txt(gg, p.x, 99, null, 'tx').textContent = k === 'c3.a' ? 'A' : 'B';
    txt(rc, p.x, 148, k, 'tx s');
    p.res = txt(rc, p.x, 172, null, 'tx fade');
    p.g = gg;
  }
  const apt = node(rc, { x: 450, y: 95, w: 124, h: 48, label: 'c3.apt' });
  const lock = svgEl('g', { class: 'lock open', transform: 'translate(438 26)' }, rc);
  svgEl('path', { class: 'shackle', d: 'M6 12 V8 a6 6 0 0 1 12 0 V12' }, lock);
  svgEl('path', { d: 'M3 12 h18 v12 h-18 z' }, lock);
  const btn = body.querySelector('.c3-race .sk-btn'), res = body.querySelector('.c3-res');
  let round = 0;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    round++;
    for (const p of [A, B]) { p.res.classList.remove('on'); p.g.classList.remove('hot', 'dim'); }
    apt.classList.remove('hot'); lock.classList.add('open');
    const aWins = Math.random() < .5, win = aWins ? A : B, lose = aWins ? B : A;
    const [pw, pl] = aWins ? [pa, pb] : [pb, pa];
    const jitter = 40 + Math.random() * 80;
    const first = packet(pw, { ms: 900, keep: true });
    await wait(jitter);
    const second = packet(pl, { ms: 900, keep: true });
    const dw = await first;
    lock.classList.remove('open'); apt.classList.add('hot');
    const dl = await second;
    dl.classList.add('bad');
    dw.classList.add('ok');
    await wait(250);
    dw.remove(); dl.remove();
    await Promise.all([packet(pw, { ms: 700, reverse: true, cls: 'ok' }), packet(pl, { ms: 700, reverse: true, cls: 'bad' })]);
    win.res.textContent = t('c3.win'); win.res.dataset.t = 'c3.win'; win.res.style.fill = 'var(--ok)';
    lose.res.textContent = t('c3.lose'); lose.res.dataset.t = 'c3.lose'; lose.res.style.fill = 'var(--danger)';
    win.res.classList.add('on'); lose.res.classList.add('on');
    win.g.classList.add('hot'); lose.g.classList.add('dim');
    res.textContent = `#${round} · ${aWins ? 'A' : 'B'} ✓`;
    btn.disabled = false;
  });

  return {
    async start() {
      if (reduce) { show(2); dep.classList.add('on'); return; }
      for (;;) { if (seen) await cycle(); else await wait(800); }
    }
  };
}

// ---------- 4. Payments ----------
const FLOWS = {
  humo: { steps: [[0, 1, 'c4.humo.1'], [1, 2, 'c4.humo.2'], [2, 1, 'c4.humo.3'], [1, 3, 'c4.apply']], dup: [0, 1, 'c4.humo.4'], chips: ['HUMO / Uzcard', 'OTP', 'Idempotency-Key'] },
  click: { steps: [[0, 2, 'c4.click.1'], [2, 1, 'c4.click.2'], [2, 1, 'c4.click.3'], [1, 3, 'c4.apply']], dup: [2, 1, 'c4.click.4'], chips: ['Click SHOP API', 'sign_string MD5', 'provider_events'] },
  stripe: { steps: [[0, 2, 'c4.stripe.1'], [0, 2, 'c4.stripe.2'], [2, 1, 'c4.stripe.3'], [1, 3, 'c4.apply']], dup: [2, 1, 'c4.stripe.4'], chips: ['Stripe Checkout', 'Webhook signature', 'provider_events'] }
};
export function scene4(body) {
  body.innerHTML = `<div class="sk-stage"><span class="sk-sim" data-t="sim"></span>
      <div class="sk-row"><div class="sk-seg" role="tablist"><button data-p="humo" class="on">HUMO</button><button data-p="click">Click</button><button data-p="stripe">Stripe</button></div>
      <span class="grow"></span><button class="sk-btn" data-replay data-t="replay"></button></div>
      <svg viewBox="0 0 900 430" aria-hidden="true"></svg><div class="c4-note"></div>
      <div class="sk-proof" data-t="c4.proof"></div></div><div class="c4-chips"></div>`;
  const svg = body.querySelector('svg'), note = body.querySelector('.c4-note'), chipBox = body.querySelector('.c4-chips');
  const X = [110, 340, 570, 800], HEADS = ['c4.buyer', 'c4.site', 'c4.prov', 'c4.core'];
  const ar = arrowDefs(svg, 'c4ar', 'var(--gold)'), arDup = arrowDefs(svg, 'c4ard', 'var(--faint)');
  X.forEach((x, i) => {
    svgEl('line', { x1: x, y1: 58, x2: x, y2: 410, class: 'c4-life' }, svg);
    const g = svgEl('g', { class: 'c4-head' }, svg);
    svgEl('rect', { x: x - 82, y: 18, width: 164, height: 38, rx: 8 }, g);
    txt(g, x, 42, HEADS[i]);
  });
  const layer = svgEl('g', {}, svg);
  let run = 0, prov = 'humo';

  const msg = (from, to, y, key, dup = false) => {
    const x1 = X[from] + (to > from ? 6 : -6), x2 = X[to] + (to > from ? -8 : 8);
    const p = drawable(svgEl('path', { class: `c4-msg${dup ? ' dup' : ''}`, d: `M${x1} ${y} L${x2} ${y}`, 'marker-end': dup ? arDup : ar }, layer));
    const l = txt(layer, (x1 + x2) / 2, y - 9, key, `tx s fade${dup ? '' : ' g'}`);
    requestAnimationFrame(() => { p.classList.add('on'); l.classList.add('on'); });
  };
  const box = (x, y, w, key, cls) => {
    const g = svgEl('g', { class: `${cls} fade` }, layer);
    svgEl('rect', { x: x - w / 2, y: y - 17, width: w, height: 34, rx: 17 }, g);
    txt(g, x, y + 4, key, 'tx s');
    requestAnimationFrame(() => g.classList.add('on'));
  };
  async function play() {
    const my = ++run, f = FLOWS[prov];
    layer.innerHTML = '';
    note.dataset.t = `c4.note.${prov}`; note.textContent = t(note.dataset.t);
    chipBox.innerHTML = chips(f.chips);
    let y = 98;
    for (const [a, b, k] of f.steps) {
      if (my !== run) return;
      msg(a, b, y, k);
      y += 54;
      await wait(820);
    }
    if (my !== run) return;
    box(X[3] - 115, y - 8, 290, 'c4.done', 'c4-done');
    await wait(1100);
    if (my !== run) return;
    y += 50;
    msg(f.dup[0], f.dup[1], y, f.dup[2], true);
    await wait(700);
    if (my !== run) return;
    box(X[1] + 115, y + 34, 290, 'c4.dup', 'c4-badge');
  }
  for (const b of body.querySelectorAll('[data-p]')) b.addEventListener('click', () => {
    body.querySelectorAll('[data-p]').forEach(x => x.classList.toggle('on', x === b));
    prov = b.dataset.p;
    play();
  });
  body.querySelector('[data-replay]').addEventListener('click', play);
  return { start: play };
}

// ---------- 5. Agents ----------
const AGENTS = ['qualifier', 'apt_finder', 'finance', 'kb_consultant', 'booking', 'analyst'];
const QUESTIONS = [
  { q: 'c5.q1', a: 'c5.a1', agent: 1, tool: 'search_apartments' },
  { q: 'c5.q2', a: 'c5.a2', agent: 2, tool: 'calc_mortgage' },
  { q: 'c5.q3', a: 'c5.a3', agent: 4, tool: 'create_booking', gate: true },
  { q: 'c5.q4', a: 'c5.a4', agent: 3, tool: 'search_kb' }
];
export function scene5(body) {
  body.innerHTML = `<div class="sk-stage"><span class="sk-sim" data-t="sim"></span><div class="c5-wrap">
      <div class="c5-qs"><div class="c5-label" data-t="c5.pick"></div>${QUESTIONS.map((q, i) => `<button data-q="${i}" data-t="${q.q}"></button>`).join('')}
        <label class="c5-toggle"><input type="checkbox"><span data-t="c5.fail"></span></label></div>
      <div><div style="position:relative"><svg viewBox="0 0 640 460" aria-hidden="true"></svg><button class="sk-btn primary c5-gate-btn" data-t="c5.gate"></button></div>
        <div class="c5-answer" aria-live="polite"></div></div>
    </div><div class="sk-how" data-t="c5.how"></div><div class="sk-proof" data-t="c5.proof"></div>
    <div class="c5-stats"><div><b>7</b><span data-t="c5.agents"></span></div><div><b>19</b><span data-t="c5.tools"></span></div></div></div>
    ${chips(['Gemini', 'Claude', 'tool calling', 'SSE stream', 'confirmToken', 'zod'])}`;
  const svg = body.querySelector('svg'), answer = body.querySelector('.c5-answer'), gateBtn = body.querySelector('.c5-gate-btn');
  const fail = body.querySelector('input[type=checkbox]');
  const AX = AGENTS.map((_, i) => 58 + i * 104.8);
  const qBox = svgEl('g', { class: 'nd' }, svg);
  svgEl('rect', { x: 20, y: 12, width: 600, height: 40, rx: 20 }, qBox);
  const qText = txt(qBox, 320, 37, null, 'tx');
  const toRouter = svgEl('path', { class: 'ln', d: 'M320 52 L320 92' }, svg);
  const router = node(svg, { x: 320, y: 112, w: 180, h: 40, label: 'c5.router' });
  const badge = svgEl('g', { class: 'model-badge fade' }, svg);
  svgEl('rect', { x: 432, y: 98, width: 196, height: 28, rx: 14 }, badge);
  const badgeText = txt(badge, 530, 117, null, 'tx mono');
  const toAgent = AX.map(x => svgEl('path', { class: 'ln', d: `M320 132 C320 165 ${x} 160 ${x} 184` }, svg));
  const agents = AGENTS.map((a, i) => { const g = node(svg, { x: AX[i], y: 202, w: 98, h: 36, label: null, mono: true }); g.querySelector('text').textContent = a; return g; });
  const toTool = AX.map(x => svgEl('path', { class: 'ln', d: `M${x} 220 L${x} 272` }, svg));
  const tool = svgEl('g', { class: 'nd hot fade' }, svg);
  const toolRect = svgEl('rect', { y: 274, width: 170, height: 34, rx: 8 }, tool);
  const toolText = txt(tool, 0, 295, null, 'tx mono');
  const gate = svgEl('g', { class: 'nd fade' }, svg);
  svgEl('rect', { x: 230, y: 340, width: 180, height: 36, rx: 18 }, gate);
  const gateText = txt(gate, 320, 362, 'c5.gateWait', 'tx s');
  const toGate = AX.map(x => svgEl('path', { class: 'ln', d: `M${x} 308 C${x} 330 320 322 320 340` }, svg));
  const gateToEnd = svgEl('path', { class: 'ln', d: 'M320 376 L320 410' }, svg);
  const toEnd = AX.map(x => svgEl('path', { class: 'ln', d: `M${x} 308 C${x} 380 320 370 320 410` }, svg));
  const end = svgEl('g', { class: 'nd fade' }, svg);
  svgEl('rect', { x: 230, y: 410, width: 180, height: 36, rx: 10 }, end);
  const endText = txt(end, 320, 433, null, 'tx');

  let run = 0, gateOpen = null;
  const reset = () => {
    [toRouter, gateToEnd, ...toAgent, ...toTool, ...toGate, ...toEnd].forEach(p => p.classList.remove('hot'));
    [router, ...agents].forEach(n => n.classList.remove('hot', 'dim'));
    [tool, gate, end, badge].forEach(n => n.classList.remove('on'));
    gate.classList.remove('hot'); badge.classList.remove('fb');
    gateText.dataset.t = 'c5.gateWait'; gateText.textContent = t('c5.gateWait');
    gateBtn.classList.remove('on'); answer.classList.remove('on'); answer.textContent = '';
  };
  const typeOut = async (key, my) => {
    answer.dataset.t = key;
    answer.classList.add('on');
    const s = t(key);
    if (reduce) { answer.textContent = s; return; }
    for (let i = 1; i <= s.length; i += 2) { if (my !== run) return; answer.textContent = s.slice(0, i); await new Promise(r => setTimeout(r, 16)); }
    answer.textContent = s;
  };
  async function ask(i) {
    const my = ++run, Q = QUESTIONS[i], x = AX[Q.agent];
    body.querySelectorAll('[data-q]').forEach(b => b.classList.toggle('on', Number(b.dataset.q) === i));
    reset();
    qText.dataset.t = Q.q; qText.textContent = t(Q.q);
    toRouter.classList.add('hot');
    await packet(toRouter, { ms: 500 }); if (my !== run) return;
    router.classList.add('hot');
    await wait(350); if (my !== run) return;
    toAgent[Q.agent].classList.add('hot');
    await packet(toAgent[Q.agent], { ms: 700 }); if (my !== run) return;
    agents.forEach((a, j) => a.classList.toggle(j === Q.agent ? 'hot' : 'dim', true));
    badge.classList.add('on');
    if (fail.checked) {
      badgeText.textContent = 'gemini-3.8-flash ✕';
      badge.classList.add('fb');
      await wait(650); if (my !== run) return;
      badgeText.textContent = `claude-sonnet-5-5 · ${t('c5.fallback')}`;
    } else badgeText.textContent = 'gemini-3.8-flash';
    toTool[Q.agent].classList.add('hot');
    await packet(toTool[Q.agent], { ms: 450 }); if (my !== run) return;
    toolRect.setAttribute('x', x - 85); toolText.setAttribute('x', x); toolText.textContent = Q.tool;
    tool.classList.add('on');
    await wait(500); if (my !== run) return;
    if (Q.gate) {
      toGate[Q.agent].classList.add('hot');
      await packet(toGate[Q.agent], { ms: 500 }); if (my !== run) return;
      gate.classList.add('on', 'hot');
      typeOut(Q.a, my);
      gateBtn.style.left = `${(320 / 640) * 100}%`; gateBtn.style.top = `${(358 / 460) * 100}%`;
      gateBtn.classList.add('on');
      await new Promise(ok => { gateOpen = ok; });
      if (my !== run) return;
      gateBtn.classList.remove('on');
      gateText.dataset.t = 'c5.gateOk'; gateText.textContent = t('c5.gateOk');
      gateToEnd.classList.add('hot');
      await packet(gateToEnd, { ms: 400 }); if (my !== run) return;
      endText.removeAttribute('data-t'); endText.textContent = 'bookings.hold()'; endText.classList.add('mono');
      end.classList.add('on');
      return;
    }
    toEnd[Q.agent].classList.add('hot');
    await packet(toEnd[Q.agent], { ms: 650 }); if (my !== run) return;
    endText.classList.remove('mono'); endText.dataset.t = 'c6.answer'; endText.textContent = t('c6.answer');
    end.classList.add('on');
    typeOut(Q.a, my);
  }
  gateBtn.addEventListener('click', () => { gateOpen?.(); gateOpen = null; });
  for (const b of body.querySelectorAll('[data-q]')) b.addEventListener('click', () => { gateOpen = null; ask(Number(b.dataset.q)); });
  fail.addEventListener('change', () => { const on = body.querySelector('[data-q].on'); gateOpen = null; ask(on ? Number(on.dataset.q) : 0); });
  onLang(() => { if (badge.classList.contains('fb') && !badgeText.textContent.includes('✕')) badgeText.textContent = `claude-sonnet-5-5 · ${t('c5.fallback')}`; });
  return { start: () => ask(0) };
}
