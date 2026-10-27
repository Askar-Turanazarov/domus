// The dashboard page (12 §9): the same sign-in as the admin (one session cookie), then the full-screen dashboard.
import { api, onSignedOut, ApiError } from '../admin/api.js';
import { el, toast } from '../admin/ui.js';
import { t, setLang, hasSavedLang } from '../admin/i18n.js';
import { mount } from './dashboard.js';

const app = document.getElementById('app');
let stop = null;

function show(staff) {
  stop?.();
  stop = mount(app, { staff });
}

function renderLogin(message = '') {
  stop?.(); stop = null;
  const err = el('p', { class: 'adm2-err', role: 'alert' }, message);
  const login = el('input', { type: 'text', name: 'login', required: true, maxLength: 100, autocomplete: 'username', autofocus: true });
  const pass = el('input', { type: 'password', name: 'password', required: true, maxLength: 200, autocomplete: 'current-password' });
  const submit = el('button', { type: 'submit', class: 'btn primary' }, t('login.submit'));
  const form = el('form', { class: 'adm2-login', on: { submit: async e => {
    e.preventDefault();
    submit.disabled = true; err.textContent = '';
    try {
      const { staff } = await api('/api/admin/login', { method: 'POST', body: { login: login.value.trim(), password: pass.value } });
      if (!hasSavedLang()) setLang(staff.lang, false);
      show(staff);
    } catch (ex) {
      err.textContent = ex instanceof ApiError ? ex.message : t('app.fail');
      pass.value = ''; submit.disabled = false;
    }
  } } }, el('h1', {}, 'Chinor Park'), el('h2', {}, t('login.title')),
  el('label', {}, el('span', {}, t('login.login')), login), el('label', {}, el('span', {}, t('login.password')), pass), err, submit);
  app.replaceChildren(el('div', { class: 'adm2-center' }, form));
}

onSignedOut(() => renderLogin());

(async function boot() {
  app.replaceChildren(el('p', { class: 'adm2-empty' }, t('app.loading')));
  try {
    const { staff } = await api('/api/admin/me');
    if (!hasSavedLang()) setLang(staff.lang, false);
    show(staff);
  } catch (ex) {
    if (ex instanceof ApiError && (ex.status === 401 || ex.status === 503)) renderLogin(ex.status === 503 ? ex.message : '');
    else { renderLogin(); toast(t('app.fail'), true); }
  }
})();
