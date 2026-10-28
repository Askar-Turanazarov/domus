// The mini app mode of the showcase (11 §8, 10 §7): the server serves /mini with <html data-mode="mini"> and the Telegram script.
// Here: ready/expand, the Telegram theme as CSS variables and the Domus theme, X-Tg-Init-Data on every /api request
// (the hold and the payment go to /api/mini/*), MainButton / BackButton / HapticFeedback, «Мои брони», and
// «Откройте витрину из бота» when the page was opened in a plain browser. The booking page and the payment emulators
// opened from the mini app (plain navigation, 10 §7.4) keep the mode: a flag in sessionStorage, the script loaded here.
const FLAG = 'domus.mini';
const TG_SCRIPT = 'https://telegram.org/js/telegram-web-app.js';
const ROUTES = [['POST', /^\/api\/bookings\/hold$/, '/api/mini/bookings/hold'], ['POST', /^\/api\/payments$/, '/api/mini/payments']];
const THEME_KEYS = { bg_color: '--tg-bg', text_color: '--tg-text', hint_color: '--tg-hint', link_color: '--tg-link', button_color: '--tg-button',
  button_text_color: '--tg-button-text', secondary_bg_color: '--tg-secondary-bg' };
const TEXT = {
  ru: { title: 'Откройте витрину из бота', text: 'Эта страница работает внутри Telegram. Откройте бота Chinor Park и нажмите кнопку меню.', site: 'Перейти на сайт',
    mine: 'Мои брони', none: 'Броней пока нет.', fail: 'Не удалось загрузить брони.', close: 'Закрыть',
    st: { held: 'удержана до {t}', booked: 'забронирована до {t}', converted: 'куплена' }, apt: 'Квартира №{no}', bk: 'Бронь №{no}' },
  uz: { title: 'Vitrinani botdan oching', text: 'Bu sahifa Telegram ichida ishlaydi. Chinor Park botini oching va menyu tugmasini bosing.', site: 'Saytga o‘tish',
    mine: 'Mening bronlarim', none: 'Hozircha bron yo‘q.', fail: 'Bronlarni yuklab bo‘lmadi.', close: 'Yopish',
    st: { held: '{t} gacha ushlab turilgan', booked: '{t} gacha bron qilingan', converted: 'sotib olingan' }, apt: '№{no} kvartira', bk: '№{no} bron' },
  en: { title: 'Open the showcase from the bot', text: 'This page works inside Telegram. Open the Chinor Park bot and press the menu button.', site: 'Go to the website',
    mine: 'My bookings', none: 'No bookings yet.', fail: 'Could not load the bookings.', close: 'Close',
    st: { held: 'held until {t}', booked: 'booked until {t}', converted: 'bought' }, apt: 'Apartment №{no}', bk: 'Booking №{no}' }
};
// The main action of a screen (10 §7.3): the first visible one — the hold form, the card, then the page (booking: «Оплатить»).
const MAIN = ['#holdDlg[open] #holdGo', '#aptDlg[open] #aptBook', '#aptDlg[open] #aptContinue', 'main .btn.primary'];

const langOf = doc => (['ru', 'uz', 'en'].includes(doc.documentElement.lang) ? doc.documentElement.lang : 'ru');
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);
const clean = s => String(s ?? '').replace(/^[^\p{L}\p{N}]+/u, '').trim();

// fetch(input, init) → [url, init] for the mini app: the header always, the two public entries renamed.
export function miniRequest(input, init = {}, initData, origin) {
  const url = new URL(typeof input === 'string' ? input : input.url, origin);
  if (url.origin !== origin || !url.pathname.startsWith('/api/')) return [input, init];
  const method = String(init.method ?? 'GET').toUpperCase();
  const route = ROUTES.find(([m, re]) => m === method && re.test(url.pathname));
  if (route) url.pathname = route[2];
  const headers = new Headers(init.headers ?? (typeof input === 'string' ? undefined : input.headers));
  headers.set('X-Tg-Init-Data', initData);
  return [url.pathname + url.search, { ...init, headers }];
}

// themeParams → --tg-* variables; colorScheme → the Domus light / dark theme (data-theme).
export function applyTheme(root, tg) {
  for (const [k, v] of Object.entries(THEME_KEYS)) {
    if (tg.themeParams?.[k]) root.style.setProperty(v, tg.themeParams[k]);
  }
  root.dataset.theme = tg.colorScheme === 'light' ? 'light' : 'dark';
}

function outside(doc) {
  const tx = TEXT[langOf(doc)];
  const box = doc.createElement('div');
  box.className = 'mini-outside';
  box.setAttribute('role', 'alert');
  box.innerHTML = '<h1></h1><p></p><a></a>';
  box.querySelector('h1').textContent = tx.title;
  box.querySelector('p').textContent = tx.text;
  box.querySelector('a').textContent = tx.site;
  box.querySelector('a').href = `/${langOf(doc)}`;
  doc.body.prepend(box);
}

// The element MainButton stands for, and its label («Забронировать №41» on the card).
export function mainAction(doc) {
  for (const sel of MAIN) {
    const el = [...doc.querySelectorAll(sel)].find(e => !e.hidden && !e.closest('[hidden]'));
    if (!el) continue;
    let label = clean(el.textContent);
    const no = el.id === 'aptBook' && /№\s*(\d+)/.exec(doc.getElementById('aptTitle')?.textContent ?? '')?.[1];
    if (no && !label.includes('№')) label += ` №${no}`;
    return { el, label, enabled: !el.disabled };
  }
  return null;
}

// MainButton mirrors the main action; BackButton closes the open dialog on the showcase, goes back on the other pages.
function bindButtons(win, tg) {
  const doc = win.document;
  const main = tg.MainButton, back = tg.BackButton;
  let current = null;
  const sync = () => {
    const a = mainAction(doc);
    current = a?.el ?? null;
    if (main) {
      if (a) { main.setText?.(a.label); a.enabled ? main.enable?.() : main.disable?.(); main.show?.(); } else main.hide?.();
    }
    const dialog = [...doc.querySelectorAll('dialog[open]')].at(-1);
    if (back) (dialog || doc.documentElement.dataset.page !== 'showcase' ? back.show?.() : back.hide?.());
  };
  main?.onClick?.(() => {
    if (!current) return;
    if (current.type === 'submit' && current.form) current.form.requestSubmit(current); else current.click();
  });
  back?.onClick?.(() => {
    const dialog = [...doc.querySelectorAll('dialog[open]')].at(-1);
    if (dialog) dialog.close(); else win.history.back();
    sync();
  });
  let queued = false;
  new win.MutationObserver(() => {
    if (queued) return;
    queued = true;
    win.setTimeout(() => { queued = false; sync(); }, 50);
  }).observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'hidden', 'disabled'] });
  doc.addEventListener('input', sync);
  doc.addEventListener('change', sync);
  sync();
}

// «Мои брони» (11 §8): a button over the showcase → GET /api/mini/bookings → the list with the links to the booking pages.
function mountMine(win) {
  const doc = win.document, tx = TEXT[langOf(doc)];
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = 'btn mini-mine-btn';
  btn.textContent = `📋 ${tx.mine}`;
  const dlg = doc.createElement('dialog');
  dlg.className = 'mini-mine';
  dlg.innerHTML = '<h2></h2><ul></ul><div class="btn-row end"><button type="button" class="btn ghost"></button></div>';
  dlg.querySelector('h2').textContent = tx.mine;
  dlg.querySelector('.btn.ghost').textContent = tx.close;
  dlg.querySelector('.btn.ghost').addEventListener('click', () => dlg.close());
  const time = s => new Date(s).toLocaleString(langOf(doc), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tashkent' });
  btn.addEventListener('click', async () => {
    const ul = dlg.querySelector('ul');
    ul.replaceChildren();
    dlg.showModal();
    try {
      const r = await win.fetch('/api/mini/bookings');
      if (!r.ok) throw new Error(r.status);
      const { items } = await r.json();
      if (!items.length) ul.innerHTML = `<li class="mini-none"></li>`, ul.firstChild.textContent = tx.none;
      for (const b of items) {
        const li = doc.createElement('li');
        const a = doc.createElement('a');
        a.href = /^\/b\/[\w-]+$/.test(b.link) ? b.link : '#';
        a.textContent = `${fill(tx.bk, { no: b.no })} · ${fill(tx.apt, { no: b.apartmentNo })}`;
        const s = doc.createElement('span');
        s.textContent = fill(tx.st[b.status] ?? b.status, { t: time(b.expiresAt) });
        li.append(a, s);
        ul.append(li);
      }
    } catch {
      ul.innerHTML = '<li class="mini-none"></li>';
      ul.firstChild.textContent = tx.fail;
    }
  });
  doc.body.append(btn, dlg);
}

function loadTelegram(win) {
  if (win.Telegram?.WebApp) return Promise.resolve(win.Telegram.WebApp);
  return new Promise(resolve => {
    const s = win.document.createElement('script');
    s.src = TG_SCRIPT;
    s.onload = () => resolve(win.Telegram?.WebApp ?? null);
    s.onerror = () => resolve(null);
    win.document.head.append(s);
  });
}

function setup(win, tg) {
  const doc = win.document;
  applyTheme(doc.documentElement, tg);
  tg.onEvent?.('themeChanged', () => applyTheme(doc.documentElement, tg));
  tg.ready?.();
  tg.expand?.();
  const run = () => {
    applyTheme(doc.documentElement, tg);                                   // after the page's own theme.js
    if (doc.getElementById('aptDlg')) doc.documentElement.dataset.page ??= 'showcase';   // the showcase: /mini, or /ru back from a booking
    bindButtons(win, tg);
    if (doc.documentElement.dataset.page === 'showcase') mountMine(win);
    if (new URLSearchParams(win.location.search ?? '').get('paid')) tg.HapticFeedback?.notificationOccurred?.('success');
  };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', run, { once: true }); else run();
}

// The showcase /mini: Telegram is there already (the server put the script before this one).
export function startMini(win = window) {
  const doc = win.document;
  if (doc.documentElement.dataset.mode !== 'mini') return null;
  const tg = win.Telegram?.WebApp;
  const initData = tg?.initData ?? '';
  if (!initData) {
    if (doc.body) outside(doc); else doc.addEventListener('DOMContentLoaded', () => outside(doc), { once: true });
    return null;
  }
  try { win.sessionStorage?.setItem(FLAG, '1'); } catch { /* private mode: the next pages stay plain */ }
  const plain = win.fetch.bind(win);
  win.fetch = (input, init) => plain(...miniRequest(input, init, initData, win.location.origin));
  setup(win, tg);
  return tg;
}

// A page opened from the mini app (/b/…, /pay/…): the mode by the flag, the script loaded now; the API calls wait for it.
export function continueMini(win = window) {
  let flag = null;
  try { flag = win.sessionStorage?.getItem(FLAG); } catch { /* no storage — a plain page */ }
  if (flag !== '1') return null;
  const doc = win.document;
  doc.documentElement.dataset.mode = 'mini';
  const tgReady = loadTelegram(win);
  const plain = win.fetch.bind(win);
  win.fetch = async (input, init) => {
    const tg = await tgReady;
    return tg?.initData ? plain(...miniRequest(input, init, tg.initData, win.location.origin)) : plain(input, init);
  };
  return tgReady.then(tg => {
    if (!tg?.initData) {                                                   // not Telegram after all: back to the plain site
      try { win.sessionStorage.removeItem(FLAG); } catch { /* nothing to clear */ }
      delete doc.documentElement.dataset.mode;
      return null;
    }
    setup(win, tg);
    return tg;
  });
}

if (typeof window !== 'undefined' && window.document) {
  if (window.document.documentElement.dataset.mode === 'mini') startMini(window); else continueMini(window);
}
