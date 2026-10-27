// Manager page «Журнал вызовов»: the MCP call log (tool_calls) through GET /api/calls, refreshed every 3 s.
// Each subagent has its own tools, so the tool tells who called. Same sign-in as the orders page (manager password → session cookie, adminAuth.js); data goes in as text only.
import { t, getLang, applyStatic, initLangSwitcher, onLangChange } from './i18n.js';
import { initTheme } from './theme.js';
import { initIcons } from './icons.js';
import { adminAuth } from './adminAuth.js';

const $ = id => document.getElementById(id);
const LOCALE = { ru: 'ru-RU', uz: 'uz-UZ', en: 'en-GB' };
const EVERY_MS = 3000;
const AGENT = { search_apartments: 'apt_finder', get_apartment: 'apt_finder', calc_mortgage: 'mortgage_consultant', book_viewing: 'booking_manager' };
const loc = () => LOCALE[getLang()] || 'en-GB';
const when = iso => new Date(iso).toLocaleString(loc(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Tashkent' });
const sum = n => `${Number(n).toLocaleString('ru-RU')} ${t('unit.sum')}`;

// The arguments in a few words: «2 комн. · до 900 000 000 сум», «№10 · 20 % · 15 лет · 22 %».
function argsText(tool, a = {}) {
  if (Array.isArray(a.fields)) return t('cl.fields', { v: a.fields.join(', ') || '—' });   // refused before the tool: names only
  const parts = [];
  if (tool === 'search_apartments') {
    if (a.rooms != null) parts.push(a.rooms ? t('cl.rooms', { n: a.rooms }) : t('bld.type.studio'));
    if (a.maxPrice != null) parts.push(t('cl.upTo', { v: sum(a.maxPrice) }));
    if (a.minArea != null) parts.push(t('cl.from', { v: a.minArea + ' ' + t('unit.m2') }));
    if (a.floor != null) parts.push(t('bld.floor', { n: a.floor }));
    if (a.status && a.status !== 'free') parts.push(a.status === 'any' ? '*' : t('bld.st.' + a.status));
  } else if (tool === 'calc_mortgage') {
    if (a.loan != null) parts.push(t('cl.loan', { v: sum(a.loan) }));
    if (a.price != null) parts.push(sum(a.price));
    if (a.no != null) parts.push('№' + a.no);
    if (a.downPct) parts.push(`${a.downPct} %`);
    parts.push(t('cl.years', { n: a.years }), `${a.rate} %`);
  } else {
    if (a.no != null) parts.push('№' + a.no);
    if (a.datetime) parts.push(String(a.datetime).replace('T', ' '));
  }
  return parts.join(' · ') || '—';
}

// The stat chips are filters: one kind of entry at a time, a second click (or «Показать все») shows everything.
const AGENTS = ['apt_finder', 'mortgage_consultant', 'booking_manager'];
const FILTERS = {
  calls: e => e.type === 'call',
  errors: e => e.type === 'call' && !e.ok,
  denied: e => e.type === 'denied',
  ...Object.fromEntries(AGENTS.map(a => [a, e => e.type === 'call' && AGENT[e.tool] === a]))
};
const CHIP_CLASS = { calls: '', errors: 'bad', denied: 'deny' };

let auth;
let signedIn = false;
let filter = null;
let events = [];
let shown = '';
let timer = null;
let failed = false;

let toastTimer;
function toast(text) {
  const box = $('toast');
  box.textContent = text;
  box.className = 'toast error';
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 5000);
}

function stop() {
  signedIn = false;
  clearInterval(timer);
  timer = null;
  events = [];
  shown = '';
  filter = null;
}

async function load() {
  if (!signedIn || document.hidden) return;
  let res;
  try { res = await fetch('/api/calls', { cache: 'no-store' }); } catch { res = null; }
  if (res && (res.status === 401 || res.status === 503)) return auth.signedOut(res.status);
  if (!res || !res.ok) {
    if (!failed) toast(t('cl.loadFail'));
    failed = true;
    return renderStats();
  }
  failed = false;
  events = await res.json();
  render();
}

const chip = (text, cls) => Object.assign(document.createElement('span'), { className: 'cl-chip ' + cls, textContent: text });

// The chips are built once and only relabelled every 3 s, so a hover tooltip or a press never gets cut off.
function buildStats() {
  const box = $('clStats');
  const buttons = Object.keys(FILTERS).map(kind => {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'cl-chip cl-filter ' + (CHIP_CLASS[kind] ?? 'agent') });
    b.dataset.kind = kind;
    b.setAttribute('aria-pressed', 'false');
    b.append(Object.assign(document.createElement('span'), { className: 'cl-label' }),
      Object.assign(document.createElement('span'), { className: 'cl-tip', role: 'tooltip', id: 'clTip-' + kind }));
    b.setAttribute('aria-describedby', 'clTip-' + kind);
    b.addEventListener('click', () => setFilter(filter === kind ? null : kind));
    b.addEventListener('pointerenter', () => placeTip(b));
    b.addEventListener('focus', () => placeTip(b));
    return b;
  });
  const reset = Object.assign(document.createElement('button'), { type: 'button', id: 'clReset', className: 'cl-reset', hidden: true });
  reset.addEventListener('click', () => setFilter(null));
  box.replaceChildren(...buttons, reset, Object.assign(document.createElement('span'), { className: 'bk-live', id: 'clLive' }));
}

// The tooltip opens under its chip; near the right edge it slides left to stay on screen (the arrow stays on the chip).
function placeTip(b) {
  const tip = b.querySelector('.cl-tip');
  const left = b.getBoundingClientRect().left;
  const shift = Math.min(0, document.documentElement.clientWidth - 12 - (left + tip.offsetWidth));
  tip.style.setProperty('--shift', Math.max(shift, 8 - left) + 'px');
}

function setFilter(kind) {
  filter = kind;
  render(true);
}

function renderStats() {
  const count = kind => events.filter(FILTERS[kind]).length;
  const label = { calls: n => t('cl.total', { n }), errors: n => t('cl.errors', { n }), denied: n => t('cl.denied', { n }) };
  for (const b of $('clStats').querySelectorAll('.cl-filter')) {
    const kind = b.dataset.kind;
    const n = count(kind);
    b.querySelector('.cl-label').textContent = label[kind] ? label[kind](n) : `${kind}: ${n}`;
    b.querySelector('.cl-tip').textContent = t('cl.tip.' + kind);
    b.setAttribute('aria-pressed', String(filter === kind));
    b.classList.toggle('zero', !n);
  }
  const reset = $('clReset');
  reset.hidden = !filter;
  reset.textContent = '✕ ' + t('cl.reset');
  $('clLive').textContent = failed ? t('bk.offline') : t('cl.live', { time: new Date().toLocaleTimeString(loc(), { timeZone: 'Asia/Tashkent' }) });
}

function render(force = false) {
  renderStats();
  const key = JSON.stringify(events) + getLang() + filter;
  if (!force && key === shown) return;
  shown = key;
  const list = filter ? events.filter(FILTERS[filter]) : events;
  $('clEmpty').hidden = list.length > 0;
  $('clEmpty').textContent = t(filter ? 'cl.emptyFilter' : 'cl.empty');
  $('clTable').hidden = !list.length;
  $('clRows').replaceChildren(...list.map(e => {
    const tr = document.createElement('tr');
    const denied = e.type === 'denied';
    const result = denied ? chip(t(e.reason === 'bad_token' ? 'cl.badToken' : 'cl.noToken'), 'deny')
      : chip(e.ok ? t('cl.ok') : t('cl.err'), e.ok ? 'good' : 'bad');
    const resCell = document.createElement('span');
    const msg = e.msgs?.[getLang()] || e.msg || e.error;   // the result line (older logs) or the error code (tool_calls)
    resCell.append(result, msg ? ' ' + msg : '');
    for (const cell of [when(e.at), denied ? '—' : AGENT[e.tool] || '—', denied ? '—' : e.tool, denied ? '—' : argsText(e.tool, e.args), resCell, denied ? '' : String(e.ms ?? '')]) {
      const td = document.createElement('td');
      td.append(cell);
      tr.append(td);
    }
    if (denied) tr.className = 'cl-denied';
    return tr;
  }));
}

function start() {
  signedIn = true;
  load();
  clearInterval(timer);
  timer = setInterval(load, EVERY_MS);
}

function init() {
  applyStatic();
  initLangSwitcher();
  initTheme();
  initIcons();
  buildStats();
  onLangChange(() => { if (!$('clList').hidden) render(true); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  auth = adminAuth({ list: 'clList', onIn: start, onOut: stop });
}

init();
