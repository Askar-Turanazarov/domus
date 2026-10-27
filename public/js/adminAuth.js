// Staff sign-in for admin.html, bookings.html and calls.html: login and password go to POST /api/admin/login once,
// the server answers with an HttpOnly session cookie (12 h) — nothing secret is kept in the page or in storage.
// list — the id of the page's private section; onIn() loads the data, onOut() stops polling and clears the view.
import { t } from './i18n.js';

const $ = id => document.getElementById(id);
const MSG = { 401: 'adm.badPassword', 429: 'adm.tooMany', 503: 'adm.disabled' };
// A hint, not a secret: "signed in on this browser before". The page head reads it so the login form
// doesn't flash between admin pages; the cookie still decides — a 401 from the data shows the form again.
const HINT = 'fsp3d.adm';

function remember(signedIn) {
  if (signedIn) document.documentElement.dataset.adm = 'in';
  else delete document.documentElement.dataset.adm;
  try { signedIn ? localStorage.setItem(HINT, '1') : localStorage.removeItem(HINT); } catch { /* private mode */ }
}

export function adminAuth({ list, onIn, onOut = () => {} }) {
  function show(signedIn, msg = '') {
    remember(signedIn);
    $(list).hidden = !signedIn;
    $('admLogout').hidden = !signedIn;
    $('admLogin').hidden = signedIn;
    $('admLoginErr').textContent = msg;
    if (!signedIn) onOut();
  }

  // An API call answered 401 / 503: the session ended (expired, new password) or the manager page is off.
  const signedOut = status => show(false, status === 503 ? t('adm.disabled') : t('adm.expired'));

  $('admLogin').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target;
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    let res = null;
    try {
      res = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'domus-admin' },
        body: JSON.stringify({ login: form.elements.login.value, password: form.elements.password.value }) });
    } catch { /* offline */ }
    button.disabled = false;
    if (res?.ok) {
      form.reset();
      show(true);
      onIn();
    } else {
      $('admLoginErr').textContent = t(MSG[res?.status] || 'adm.loginFail');
      form.elements.password.select();
    }
  });

  $('admLogout').addEventListener('click', async () => {
    try { await fetch('/api/admin/logout', { method: 'POST', headers: { 'X-Requested-With': 'domus-admin' } }); } catch { /* the cookie ends by itself */ }
    show(false);
  });

  // Signed in here before: straight to the data, its own request checks the session.
  if (document.documentElement.dataset.adm === 'in') {
    show(true);
    onIn();
    return { signedOut };
  }

  // Maybe signed in without the hint (storage cleared)? Ask the server once.
  fetch('/api/admin/me', { cache: 'no-store' }).then(r => {
    if (r.ok) { show(true); onIn(); } else show(false, r.status === 503 ? t('adm.disabled') : '');
  }, () => show(false, t('adm.loginFail')));

  return { signedOut };
}
