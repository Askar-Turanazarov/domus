// The admin shell (12 §1–2): sign-in form, header, left menu and the router on location.hash (#/section/param…).
// Data from the server goes into the page as text only.
import { api, onSignedOut, ApiError } from './api.js';
import { el, toast } from './ui.js';
import { t, setLang, getLang, onLangChange, hasSavedLang, LANGS } from './i18n.js';
import { sections, defaultSection } from './views/index.js';
import { openTelegramDialog } from './telegram.js';

const app = document.getElementById('app');
let staff = null;
let stopView = null;

const THEME = 'fsp3d.theme';
function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME, next); } catch { /* storage unavailable */ }
}

export const go = path => { location.hash = '#/' + path; };
const route = () => {
  const [id, ...params] = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { id: id || defaultSection, params };
};

function stop() { if (stopView) { stopView(); stopView = null; } }

const linkTelegram = () => openTelegramDialog({ staff, onChange: me => { staff = me; renderShell(); } });

function renderLogin(message = '') {
  stop();
  document.title = t('login.title');
  const err = el('p', { class: 'adm2-err', role: 'alert' }, message);
  const login = el('input', { type: 'text', name: 'login', required: true, maxLength: 100, autocomplete: 'username', autofocus: true });
  const pass = el('input', { type: 'password', name: 'password', required: true, maxLength: 200, autocomplete: 'current-password' });
  const submit = el('button', { type: 'submit', class: 'btn primary' }, t('login.submit'));
  const form = el('form', { class: 'adm2-login', on: { submit: async e => {
    e.preventDefault();
    submit.disabled = true; submit.textContent = t('login.busy'); err.textContent = '';
    try {
      const r = await api('/api/admin/login', { method: 'POST', body: { login: login.value.trim(), password: pass.value }, lang: getLang() });
      staff = r.staff;
      if (!hasSavedLang()) setLang(staff.lang, false);
      renderShell();
    } catch (ex) {
      err.textContent = ex instanceof ApiError ? ex.message : t('app.fail');
      pass.value = '';
      submit.disabled = false; submit.textContent = t('login.submit');
    }
  } } },
  el('h1', {}, 'Chinor Park'), el('h2', {}, t('login.title')),
  el('label', {}, el('span', {}, t('login.login')), login),
  el('label', {}, el('span', {}, t('login.password')), pass),
  err, submit);
  app.replaceChildren(el('div', { class: 'adm2-center' }, form, langButtons()));
}

function langButtons() {
  return el('div', { class: 'lang', role: 'group', 'aria-label': 'Language' },
    LANGS.map(l => el('button', { type: 'button', class: l === getLang() ? 'active' : '', on: { click: () => setLang(l) } }, l.toUpperCase())));
}

function renderShell() {
  stop();
  const { id, params } = route();
  const section = sections.find(s => s.id === id && s.roles.includes(staff.role));
  document.title = `${section ? t(section.title) + ' — ' : ''}Chinor Park`;
  const nav = el('nav', { class: 'adm2-nav', 'aria-label': 'Sections' },
    sections.filter(s => s.roles.includes(staff.role)).map(s =>
      el('a', { href: '#/' + s.id, class: s.id === id ? 'active' : '' }, t(s.title),
        s.badge && el('span', { class: 'adm2-navbadge', dataset: { badge: s.badge }, hidden: true }))));
  const head = el('header', { class: 'adm2-top' },
    el('div', { class: 'adm2-brand' }, el('b', {}, 'Chinor Park'), el('span', {}, 'admin')),
    el('div', { class: 'adm2-who' }, el('span', { class: 'adm2-name' }, staff.name), el('span', { class: 'adm2-role' }, t('role.' + staff.role))),
    langButtons(),
    el('button', { type: 'button', class: 'btn ghost sm', dataset: { act: 'telegram' }, on: { click: linkTelegram } }, t(staff.telegramLinked ? 'tgl.buttonLinked' : 'tgl.button')),
    el('button', { type: 'button', class: 'btn ghost sm', title: t('nav.theme'), on: { click: toggleTheme } }, '◐'),
    el('button', { type: 'button', class: 'btn ghost sm', on: { click: logout } }, t('nav.logout')));
  const view = el('main', { class: 'adm2-view', id: 'view' });
  app.replaceChildren(head, !staff.telegramLinked && el('div', { class: 'adm2-warn' }, t('tg.warn'), ' ', el('button', { type: 'button', class: 'adm2-link', on: { click: linkTelegram } }, t('tgl.link'))), el('div', { class: 'adm2-body' }, nav, view));
  if (!section) { view.append(el('p', { class: 'adm2-empty' }, t('nav.notfound'))); return; }
  stopView = section.mount(view, { staff, params, go });
  badges();
}

// 12 §5.4: the number of dialogs waiting for a manager next to «С менеджером»; refreshed every 15 s while signed in.
let badgeTimer = null;
async function badges() {
  clearTimeout(badgeTimer);
  if (!staff) return;
  if (!document.hidden) try {
    const r = await api('/api/admin/conversations?mode=human&limit=1');
    for (const b of document.querySelectorAll('[data-badge="inbox"]')) { b.textContent = String(r.waiting); b.hidden = !r.waiting; }
  } catch { /* the badge waits for the next round */ }
  badgeTimer = setTimeout(badges, 15_000);
}

async function logout() {
  try { await api('/api/admin/logout', { method: 'POST' }); } catch { /* the cookie is cleared or already gone */ }
  staff = null;
  renderLogin();
}

onSignedOut(() => { if (staff) { staff = null; renderLogin(); } });
onLangChange(() => { staff ? renderShell() : renderLogin(); });
addEventListener('hashchange', () => { if (staff) renderShell(); });

(async function boot() {
  app.replaceChildren(el('p', { class: 'adm2-empty' }, t('app.loading')));
  try {
    staff = (await api('/api/admin/me')).staff;
    if (!hasSavedLang()) setLang(staff.lang, false);
    renderShell();
  } catch (ex) {
    if (ex instanceof ApiError && ex.status === 503) renderLogin(ex.message);
    else if (ex instanceof ApiError && ex.status === 401) renderLogin();
    else { renderLogin(); toast(t('app.fail'), true); }
  }
})();
