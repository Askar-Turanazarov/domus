// Scenes 6–10 of the stack tour: the knowledge base, Telegram and Claude, the live dashboard, quality, requirements.
import { T } from './i18n.js';
import { t, getLang, onLang, reduce, wait, html, svgEl, packet, drawable, countUp, whileVisible, tipFor } from './kit.js';

const chips = list => `<div class="sk-chips">${list.map(c => `<span class="sk-chip">${c}</span>`).join('')}</div>`;
function txt(parent, x, y, key, cls = 'tx') {
  const el = svgEl('text', { x, y, 'text-anchor': 'middle', class: cls }, parent);
  if (key) { el.dataset.t = key; el.textContent = t(key); }
  return el;
}
// A fixed pseudo-random sequence: the cloud looks the same on every visit.
function seeded(seed) { let s = seed; return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646; }

// ---------- 6. Knowledge base ----------
export function scene6(body) {
  body.innerHTML = `<div class="sk-stage">
      <div class="sk-row"><span class="c5-label" style="margin:0" data-t="c6.lang"></span><div class="sk-seg"><button data-ql="ru" class="on">RU</button><button data-ql="uz">UZ</button><button data-ql="en">EN</button></div></div>
      <svg viewBox="0 0 900 370" aria-hidden="true"></svg>
      <div class="c6-out" aria-live="polite"><div class="c6-ans"></div><small class="c6-src"></small></div>
      <div class="sk-how" data-t="c6.how"></div>
      <div class="c6-facts"><div><b>20</b><span data-t="c6.f1"></span></div><div><b>4</b><span data-t="c6.f2"></span></div><div><b>0,60</b><span data-t="c6.f3"></span></div></div></div>
    ${chips(['pgvector', 'gemini-embedding-001 · 768', 'tsvector', 'RRF', 'kb/ru · kb/uz · kb/en'])}`;
  const svg = body.querySelector('svg'), out = body.querySelector('.c6-out');
  const docs = [], chunkEls = [], dots = [];
  ['RU', 'UZ', 'EN'].forEach((l, i) => {
    const g = svgEl('g', { class: 'doc fade' }, svg);
    for (let k = 2; k >= 0; k--) {
      svgEl('rect', { x: 46 + k * 6, y: 46 + i * 96 - k * 6, width: 74, height: 72, rx: 4 }, g);
    }
    for (let k = 0; k < 4; k++) svgEl('line', { x1: 56, y1: 64 + i * 96 + k * 12, x2: 106 - (k % 2) * 16, y2: 64 + i * 96 + k * 12 }, g);
    txt(g, 83, 108 + i * 96, null, 'tx xs').textContent = l;
    docs.push(g);
  });
  const a1 = drawable(svgEl('path', { class: 'ln hot', d: 'M150 180 L212 180' }, svg));
  for (let r = 0; r < 7; r++) for (let c = 0; c < 4; c++) {
    chunkEls.push(svgEl('rect', { x: 228 + c * 26, y: 70 + r * 32, width: 20, height: 20, rx: 3, class: 'vdot fade' }, svg));
  }
  const a2 = drawable(svgEl('path', { class: 'ln hot', d: 'M346 180 L408 180' }, svg));
  // the cloud: seven topics, the instalment one is where the question lands
  const rnd = seeded(7);
  const centers = [[520, 90], [640, 70], [770, 110], [500, 240], [620, 200], [740, 260], [850, 190]];
  const TARGET = 2;
  centers.forEach(([cx, cy], ci) => {
    for (let k = 0; k < 10; k++) {
      const a = rnd() * Math.PI * 2, d = 6 + rnd() * 34;
      const x = Math.min(880, Math.max(430, cx + Math.cos(a) * d)), y = Math.min(320, Math.max(30, cy + Math.sin(a) * d * .8));
      dots.push({ el: svgEl('circle', { cx: x, cy: y, r: 3.4, class: 'vdot fade' }, svg), x, y, ci });
    }
  });
  [['c6.docs', 90], ['c6.chunks', 280], ['c6.vectors', 655]].forEach(([k, x]) => txt(svg, x, 356, k, 'tx xs'));
  const linkLayer = svgEl('g', {}, svg);
  const qPath = svgEl('path', { class: 'ln', style: 'opacity:0', d: `M655 -10 C700 30 760 70 ${centers[TARGET][0] - 8} ${centers[TARGET][1] + 4}` }, svg);
  let qlang = 'ru', run = 0, built = false;
  const qx = centers[TARGET][0] - 8, qy = centers[TARGET][1] + 4;
  const nearest = dots.map(d => ({ d, dist: Math.hypot(d.x - qx, d.y - qy) })).sort((a, b) => a.dist - b.dist).slice(0, 4).map(n => n.d);

  const showAnswer = () => {
    out.querySelector('.c6-ans').textContent = `«${T[qlang]['c6.q']}» → ${T[qlang]['c6.ans']}`;
    out.querySelector('.c6-src').textContent = T[qlang]['c6.src'];
  };
  async function build() {
    docs.forEach(d => d.classList.add('on'));
    await wait(500); a1.classList.add('on'); await wait(500);
    for (let i = 0; i < chunkEls.length; i++) { chunkEls[i].classList.add('on'); if (i % 4 === 3) await wait(60); }
    a2.classList.add('on'); await wait(450);
    for (let i = 0; i < dots.length; i++) { dots[i].el.classList.add('on'); if (i % 5 === 4) await wait(40); }
    built = true;
  }
  async function query() {
    const my = ++run;
    out.classList.remove('on');
    linkLayer.innerHTML = '';
    dots.forEach(d => d.el.classList.remove('hit'));
    svg.querySelectorAll('.vdot.q').forEach(e => e.remove());
    await wait(300); if (my !== run) return;
    const q = await packet(qPath, { ms: 1100, keep: true, r: 6 });
    if (my !== run) { q.remove(); return; }
    q.setAttribute('class', 'vdot q');
    for (const n of nearest) {
      const l = drawable(svgEl('path', { class: 'ln hot', d: `M${qx} ${qy} L${n.x} ${n.y}` }, linkLayer));
      requestAnimationFrame(() => l.classList.add('on'));
      n.el.classList.add('hit');
      await wait(180); if (my !== run) return;
    }
    await wait(400); if (my !== run) return;
    showAnswer();
    out.classList.add('on');
  }
  for (const b of body.querySelectorAll('[data-ql]')) b.addEventListener('click', () => {
    body.querySelectorAll('[data-ql]').forEach(x => x.classList.toggle('on', x === b));
    qlang = b.dataset.ql;
    if (built) query();
  });
  const thr = body.querySelectorAll('.c6-facts b')[2];
  const fmtThr = () => { thr.textContent = getLang() === 'en' ? '0.60' : '0,60'; };
  onLang(fmtThr); fmtThr();
  return { async start() { await build(); query(); } };
}

// ---------- 7. Telegram and Claude ----------
export function scene7(body) {
  body.innerHTML = `<div class="sk-stage"><span class="sk-sim" data-t="sim"></span><div class="c7-wrap">
      <div class="phone"><div class="phone-scr"><div class="phone-top"><i></i><div><span data-t="c7.group"></span><small>Chinor Park · bot</small></div></div>
        <div class="phone-body"></div></div></div>
      <div class="claude"><div class="claude-top"><i></i><i></i><i></i><span data-t="c7.claude"></span><span style="margin-left:auto" class="cl-tool">MCP · chinor-park</span></div>
        <div class="claude-body"></div></div>
    </div><div class="sk-hint" data-t="c7.hint"></div><div class="sk-how" data-t="c7.how"></div>
    <div class="sk-row" style="margin-top:14px"><button class="sk-btn" data-reset data-t="reset"></button></div></div>
    ${chips(['Telegram Bot API', 'webhook secret', 'inline keyboard', 'editMessageText', 'MCP', 'confirmToken · 10 min'])}`;
  const phone = body.querySelector('.phone-body'), chat = body.querySelector('.claude-body');
  const el = (s, parent) => { const e = html(s); parent.appendChild(e); parent.scrollTo({ top: parent.scrollHeight, behavior: reduce ? 'auto' : 'smooth' }); return e; };
  const typing = parent => el('<div class="cl-typing"><i></i><i></i><i></i></div>', parent);

  function tg() {
    phone.innerHTML = '';
    const m = el(`<div class="tg-msg"><small>Chinor Park bot</small><span data-t="c7.lead1"></span><div class="tg-edit" data-t="c7.taken"></div><button class="tg-btn" data-t="c7.take"></button></div>`, phone);
    m.querySelectorAll('[data-t]').forEach(x => { x.textContent = t(x.dataset.t); });
    m.querySelector('.tg-btn').addEventListener('click', async () => {
      m.classList.add('taken');
      await wait(900);
      const toast = el('<div class="tg-toast" data-t="c7.other"></div>', phone);
      toast.textContent = t('c7.other');
    });
  }
  let run = 0;
  async function claude() {
    const my = ++run;
    chat.innerHTML = '';
    const say = (cls, key, tool) => {
      const m = el(`<div class="cl-msg ${cls}">${tool ? '<div class="cl-tool"></div><br>' : ''}<span data-t="${key}"></span></div>`, chat);
      if (tool) m.querySelector('.cl-tool').textContent = tool;
      m.querySelector('span').textContent = t(key);
      return m;
    };
    await wait(400); if (my !== run) return;
    say('user', 'c7.ask');
    const ty = typing(chat);
    await wait(1300); ty.remove(); if (my !== run) return;
    say('ai', 'c7.draft', 'extend_booking → draft');
    const actions = el('<div class="cl-actions"><button class="sk-btn primary" data-t="c7.yes"></button></div>', chat);
    const yes = actions.querySelector('button');
    yes.textContent = t('c7.yes');
    yes.addEventListener('click', async () => {
      actions.remove();
      say('user', 'c7.yes');
      const ty2 = typing(chat);
      await wait(1100); ty2.remove(); if (my !== run) return;
      say('ai', 'c7.done', 'extend_booking + confirmToken ✓');
    });
  }
  body.querySelector('[data-reset]').addEventListener('click', () => { tg(); claude(); });
  return { start() { tg(); claude(); } };
}

// ---------- 8. Live dashboard ----------
export function scene8(body) {
  body.innerHTML = `<div class="sk-stage"><span class="sk-sim" data-t="sim"></span><div class="c8-wrap">
      <div><svg viewBox="0 0 300 200" aria-hidden="true"></svg><div style="text-align:center;margin-top:6px"><button class="sk-btn primary" data-t="c8.new"></button></div></div>
      <div class="dash"><div class="dash-kpis"><div><b data-k="0">0</b><span data-t="c8.k1"></span></div><div><b data-k="1">0</b><span data-t="c8.k2"></span></div><div><b data-k="2">0</b><span data-t="c8.k3"></span></div></div>
        <div class="dash-feed"><h5 data-t="c8.feed"></h5><ul></ul></div></div>
    </div><div class="sk-how" data-t="c8.how"></div><div class="sk-proof" data-t="c8.proof"></div></div>
    ${chips(['events', 'SSE', 'EventSource', 'Outbox', 'Asia/Tashkent'])}`;
  const svg = body.querySelector('svg'), feed = body.querySelector('.dash-feed ul');
  const g = svgEl('g', { class: 'nd hot' }, svg);
  svgEl('circle', { cx: 70, cy: 100, r: 42, class: 'box' }, g);
  txt(g, 70, 105, 'c1.core', 'tx');
  const path = svgEl('path', { class: 'ln hot', d: 'M112 100 C170 100 200 100 300 100' }, svg);
  txt(svg, 205, 88, null, 'tx xs').textContent = 'SSE';
  const k = [...body.querySelectorAll('[data-k]')].map(b => ({ b, v: 0 }));
  const APTS = [41, 57, 63, 72, 35, 19, 88, 26];
  let no = 1001;
  const bump = (i, by) => { k[i].v += by; k[i].b.textContent = k[i].v; const box = k[i].b.parentElement; box.classList.remove('flash'); box.getBoundingClientRect(); box.classList.add('flash'); setTimeout(() => box.classList.remove('flash'), 60); };
  async function fire() {
    await packet(path, { ms: 690 });
    const n = no++, apt = APTS[(n - 1001) % APTS.length];
    bump(0, 1); bump(1, 10); bump(2, 1);
    const li = html('<li><span data-t="c8.ev"></span><time></time></li>');
    const sp = li.querySelector('span');
    sp.dataset.tv = JSON.stringify({ n, apt });
    sp.textContent = t('c8.ev', { n, apt });
    li.querySelector('time').textContent = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    feed.prepend(li);
    while (feed.children.length > 5) feed.lastElementChild.remove();
  }
  body.querySelector('.sk-btn').addEventListener('click', fire);
  return { start: fire };
}

// ---------- 9. Quality ----------
const UNITS = { ru: { s: 'с', ms: 'мс' }, uz: { s: 's', ms: 'ms' }, en: { s: 's', ms: 'ms' } };
const PERF = [
  ['c9.p1', 0.02, 's', 2, 'docs/perf.md · prod 0.40 s'],
  ['c9.p2', 1.35, 's', 8, 'docs/perf.md · prod 1.48 s'],
  ['c9.p3', 17, 'ms', 500, 'docs/perf.md'],
  ['c9.p4', 39, 'ms', 300, 'docs/perf.md · p95 23–39 ms'],
  ['c9.p5', 0.69, 's', 5, 'docs/perf.md · prod < 2 s'],
  ['c9.p6', 15, 'ms', 100, 'docs/perf.md']
];
const RACES = [['c9.r1', '1 / 20 · ×5'], ['c9.r2', '1 / 20 · ×5'], ['c9.r3', '1 / 10'], ['c9.r4', '1 / 10'], ['c9.r5', '1 / 10'], ['c9.r6', '250 / 250']];
const NEON = 'eval/reports/neon-concurrency-2026-10-28.md';
const AGENTS_REPORT = 'eval/reports/agents-2026-10-28.md';
export function scene9(body) {
  body.innerHTML = `<div class="sk-stage">
      <div class="c9-counters">
        <div data-src="npm test · node --test · PGlite"><b data-n="967">0</b><span data-t="c9.tests"></span></div>
        <div class="ok" data-src="npm test · node --test · PGlite"><b data-n="961">0</b><span data-t="c9.pass"></span></div>
        <div data-src="npm test · 6 skipped by design"><b data-n="0">0</b><span data-t="c9.fail"></span></div>
        <div data-src="test/**/*.test.js"><b data-n="147">0</b><span data-t="c9.files"></span></div>
      </div>
      <div class="c9-trio">
        <div data-src="docs/security-review.md"><b data-n="0">0</b><span data-t="c9.sec"></span></div>
        <div data-src="${AGENTS_REPORT}"><b>3/3</b><span data-t="c9.inj"></span></div>
        <div data-src="${AGENTS_REPORT}"><b data-n="0">0</b><span data-t="c9.invent"></span></div>
      </div>
      <div class="c9-cols"><div><h4 data-t="c9.perf"></h4><div class="c9-perf"></div></div>
        <div><h4 data-t="c9.race"></h4><ul class="c9-race">${RACES.map(([k, v]) => `<li data-src="${NEON}"><span data-t="${k}"></span><b>${v}</b></li>`).join('')}</ul></div></div>
    </div>`;
  const perf = body.querySelector('.c9-perf');
  PERF.forEach(([k, v, unit, target, src], i) => {
    const row = html(`<div class="c9-bar"><span data-t="${k}"></span><em></em><div class="c9-track"><i style="--d:${i * 120}ms"></i></div></div>`);
    row.dataset.src = src;
    row.dataset.v = v; row.dataset.unit = unit; row.dataset.target = target;
    perf.appendChild(row);
  });
  const fmt = (v, l) => (l === 'en' ? String(v) : String(v).replace('.', ','));
  const labels = () => {
    const l = getLang(), u = UNITS[l];
    for (const row of perf.children) {
      const em = row.querySelector('em');
      em.innerHTML = '';
      const b = document.createElement('b');
      b.textContent = `${fmt(row.dataset.v, l)} ${u[row.dataset.unit]}`;
      em.append(b, ` · ${t('c9.target')} < ${fmt(row.dataset.target, l)} ${u[row.dataset.unit]}`);
    }
  };
  onLang(labels); labels();
  body.querySelectorAll('[data-src]').forEach(tipFor);
  return {
    start() {
      body.querySelectorAll('[data-n]').forEach(b => countUp(b, Number(b.dataset.n), { ms: 1600 }));
      for (const row of perf.children) row.querySelector('i').style.width = `${Math.max(1.5, (row.dataset.v / row.dataset.target) * 100)}%`;
    }
  };
}

// ---------- 10. Requirements → implementation ----------
// [group, requirements, M, S, C, code, tests] — counted from the PRD tables (171 requirements); NFR rows are norms, not M/S/C.
const GROUPS = [
  ['FR-SHOW', 7, 6, 0, 1, ['public/js/buildingPage.js', 'public/js/bld3d/', 'public/js/main.js'], ['test/showcase.test.js', 'test/building.test.js']],
  ['FR-AGT', 14, 12, 1, 1, ['server/agents/', 'server/ai/', 'server/tools/'], ['test/agents/', 'test/ai/', 'test/tools/']],
  ['FR-BKG', 14, 12, 1, 1, ['server/core/bookings.js', 'server/http/bookings.js'], ['test/core/booking.test.js', 'test/core/hold.test.js', 'test/neon/']],
  ['FR-PAY', 14, 8, 2, 3, ['server/core/payments.js', 'server/payments/'], ['test/payments/']],
  ['FR-FIN', 6, 3, 2, 0, ['server/core/finance.js'], ['test/core/finance.test.js']],
  ['FR-TG', 14, 9, 3, 2, ['server/telegram/', 'server/notify/'], ['test/telegram/', 'test/events/templates.test.js']],
  ['FR-MINI', 6, 4, 2, 0, ['server/http/mini.js', 'public/js/mini.js'], ['test/api/mini.test.js', 'test/client/mini.test.js']],
  ['FR-CRM', 7, 4, 1, 2, ['server/core/clients.js', 'server/core/dialogs.js'], ['test/core/clients.test.js', 'test/core/dialogs.test.js']],
  ['FR-ADM', 13, 8, 5, 0, ['server/http/admin*.js', 'public/admin/'], ['test/api/admin*.test.js', 'test/client/']],
  ['FR-DSH', 9, 5, 3, 1, ['server/core/analytics.js', 'pages/dashboard.html'], ['test/api/adminDashboard.test.js', 'test/client/sse.test.js']],
  ['FR-MCP', 7, 7, 0, 0, ['server/mcp/'], ['test/mcp/']],
  ['FR-I18N', 3, 3, 0, 0, ['public/js/i18n.js', 'server/i18n/'], ['test/i18n.test.js']],
  ['FR-KB', 6, 5, 0, 1, ['server/kb/', 'kb/'], ['test/kb/']],
  ['FR-FURN', 5, 0, 4, 0, ['server/core/orders.js', 'server/http/orders.js'], ['test/core/orders.test.js']],
  ['FR-DEMO', 3, 2, 0, 1, ['server/core/clock.js', 'scripts/seed.js'], ['test/core/shift.test.js', 'test/core/seedDemo.test.js']],
  ['FR-LEGAL', 1, 1, 0, 0, ['legal/', 'server/http/personalPages.js'], ['test/api/pages.test.js']],
  ['FR-NEWS', 1, 0, 0, 1, [], []],
  ['FR-LOC', 1, 0, 0, 1, [], []],
  ['FR-FX', 1, 0, 0, 1, [], []],
  ['NFR-PERF', 8, 0, 0, 0, ['docs/perf.md', 'scripts/bench.js'], ['test/perf.test.js']],
  ['NFR-REL', 6, 0, 0, 0, ['server/core/outbox.js', 'server/core/jobs.js', 'server/events/'], ['test/events/', 'test/neon/']],
  ['NFR-SEC', 7, 0, 0, 0, ['server/http/securityHeaders.js', 'server/adminAuth.js'], ['test/security/rights.test.js', 'test/securityHeaders.test.js', 'test/tools/rights.test.js']],
  ['NFR-PRIV', 5, 0, 0, 0, ['server/agents/pii.js', 'scripts/forget.js'], ['test/core/clients.test.js', 'test/tools/redact.test.js']],
  ['NFR-COST', 4, 0, 0, 0, ['server/ai/models.js', 'server/core/adminAi.js'], ['test/ai/budget.test.js', 'test/ai/quota.test.js']],
  ['NFR-UX', 5, 0, 0, 0, ['public/css/style.css', 'public/js/theme.js'], ['test/style.test.js']],
  ['NFR-OBS', 4, 0, 0, 0, ['server/health.js', 'server/http/common.js'], ['test/health.test.js']]
];
export { GROUPS };

// text with the matches of q marked (built as nodes: the query is the visitor's input).
function marked(parent, text, q) {
  if (!q) { parent.append(text); return; }
  const low = text.toLowerCase();
  let i = 0;
  for (let j = low.indexOf(q); j >= 0; j = low.indexOf(q, i)) {
    parent.append(text.slice(i, j));
    const m = document.createElement('mark');
    m.textContent = text.slice(j, j + q.length);
    parent.append(m);
    i = j + q.length;
  }
  parent.append(text.slice(i));
}

export function scene10(body) {
  body.innerHTML = `<div class="sk-stage">
      <div class="c10-tools"><input type="search" data-t-ph="c10.search" aria-label="Search"><div class="sk-seg"><button data-f="all" class="on" data-t="c10.all"></button><button data-f="FR" data-t="c10.fr"></button><button data-f="NFR" data-t="c10.nfr"></button></div></div>
      <div style="overflow-x:auto"><table class="c10-table"><thead><tr><th data-t="c10.group"></th><th data-t="c10.n"></th><th class="c10-hide" data-t="c10.prio"></th><th data-t="c10.code"></th><th class="c10-hide" data-t="c10.tests"></th></tr></thead><tbody></tbody></table></div>
    </div>`;
  const tbody = body.querySelector('tbody'), input = body.querySelector('input');
  let filter = 'all';
  function render() {
    const q = input.value.trim().toLowerCase();
    tbody.innerHTML = '';
    let shown = 0;
    for (const [id, n, m, s, c, code, tests] of GROUPS) {
      if (filter !== 'all' && !id.startsWith(`${filter}-`)) continue;
      const name = t(`g.${id.split('-')[1]}`);
      const hay = [id, name, ...code, ...tests].join(' ').toLowerCase();
      if (q && !hay.includes(q)) continue;
      const tr = document.createElement('tr');
      tr.style.animationDelay = `${Math.min(shown, 12) * 30}ms`;
      const td = (cls = '') => { const x = document.createElement('td'); if (cls) x.className = cls; tr.appendChild(x); return x; };
      const g = td();
      const idEl = document.createElement('div'); idEl.className = 'c10-id'; marked(idEl, id, q);
      const nm = document.createElement('div'); marked(nm, name, q);
      g.append(idEl, nm);
      td('c10-n').textContent = n;
      const pr = td('c10-prio c10-hide');
      if (id.startsWith('NFR')) pr.textContent = t('c10.norm');
      else {
        for (const [v, cl] of [[m, 'm'], [s, 's'], [c, 'c']]) if (v) { const i = document.createElement('i'); i.className = cl; i.style.width = `${v * 6}px`; pr.appendChild(i); }
        pr.append(` ${m} · ${s} · ${c}`);
      }
      const cd = td('c10-path');
      if (code.length) code.forEach((p, k) => { if (k) cd.append(document.createElement('br')); marked(cd, p, q); }); else cd.textContent = '—';
      const ts = td('c10-path c10-hide');
      if (tests.length) tests.forEach((p, k) => { if (k) ts.append(document.createElement('br')); marked(ts, p, q); }); else ts.textContent = '—';
      tbody.appendChild(tr);
      shown++;
    }
    if (!shown) tbody.appendChild(html(`<tr class="empty"><td colspan="5">${t('c10.none')}</td></tr>`));
  }
  input.addEventListener('input', render);
  for (const b of body.querySelectorAll('[data-f]')) b.addEventListener('click', () => {
    body.querySelectorAll('[data-f]').forEach(x => x.classList.toggle('on', x === b));
    filter = b.dataset.f;
    render();
  });
  onLang(render);
  render();
  return {};
}
