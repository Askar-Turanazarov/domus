// Manager page «Заявки на показ»: viewings (written by the MCP server) through GET /api/bookings, refreshed every 3 s.
// Same sign-in as the orders page (manager password → session cookie, adminAuth.js); user data goes into the page as text only.
import { t, getLang, applyStatic, initLangSwitcher, onLangChange } from './i18n.js';
import { initTheme } from './theme.js';
import { initIcons } from './icons.js';
import { adminAuth } from './adminAuth.js';

const $ = id => document.getElementById(id);
const LOCALE = { ru: 'ru-RU', uz: 'uz-UZ', en: 'en-GB' };
const EVERY_MS = 3000;
// viewings are booked in Tashkent time; creation times are shown in the same zone
const when = iso => new Date(iso).toLocaleString(LOCALE[getLang()] || 'en-GB', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Tashkent' });

let auth;
let signedIn = false;
let bookings = [];
let shown = '';          // the last list drawn: redraw only when it changed
let timer = null;
let failed = false;

let toastTimer;
function toast(text, isError = false) {
  const box = $('toast');
  box.textContent = text;
  box.className = 'toast' + (isError ? ' error' : '');
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, isError ? 5000 : 3000);
}

function stop() {
  signedIn = false;
  clearInterval(timer);
  timer = null;
  bookings = [];
  shown = '';
}

async function load() {
  if (!signedIn || document.hidden) return;   // a hidden tab waits; it catches up on visibilitychange
  let res;
  try { res = await fetch('/api/bookings', { cache: 'no-store' }); } catch { res = null; }
  if (res && (res.status === 401 || res.status === 503)) return auth.signedOut(res.status);
  if (!res || !res.ok) {
    if (!failed) toast(t('bk.loadFail'), true);
    failed = true;
    return renderLive();
  }
  failed = false;
  bookings = await res.json();
  render();
}

function renderLive() {
  $('bkLive').textContent = failed ? t('bk.offline') : t('bk.live', { n: bookings.length, time: new Date().toLocaleTimeString(LOCALE[getLang()] || 'en-GB', { timeZone: 'Asia/Tashkent' }) });
}

function render(force = false) {
  renderLive();
  const key = JSON.stringify(bookings) + getLang();
  if (!force && key === shown) return;
  shown = key;
  $('bkEmpty').hidden = bookings.length > 0;
  $('bkTable').hidden = !bookings.length;
  $('bkRows').replaceChildren(...bookings.map(b => {
    const tr = document.createElement('tr');
    const tel = Object.assign(document.createElement('a'), { href: 'tel:' + String(b.phone).replace(/[^\d+]/g, ''), textContent: b.phone });
    for (const cell of [when(b.createdAt), b.name, tel, '№' + b.no, when(b.datetime)]) {
      const td = document.createElement('td');
      td.append(cell);
      tr.append(td);
    }
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
  onLangChange(() => { if (!$('bkList').hidden) render(true); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  auth = adminAuth({ list: 'bkList', onIn: start, onOut: stop });
}

init();
