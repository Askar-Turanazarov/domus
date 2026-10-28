// The mini app mode of the showcase (11 §8, 10 §7): the server serves /mini with <html data-mode="mini"> and the Telegram script.
// Here: ready/expand, the Telegram theme as CSS variables and the Domus theme, X-Tg-Init-Data on every /api request
// (the hold and the payment go to /api/mini/*), and «Откройте витрину из бота» when the page was opened in a plain browser.
const ROUTES = [['POST', /^\/api\/bookings\/hold$/, '/api/mini/bookings/hold'], ['POST', /^\/api\/payments$/, '/api/mini/payments']];
const THEME_KEYS = { bg_color: '--tg-bg', text_color: '--tg-text', hint_color: '--tg-hint', link_color: '--tg-link', button_color: '--tg-button',
  button_text_color: '--tg-button-text', secondary_bg_color: '--tg-secondary-bg' };
const TEXT = {
  ru: ['Откройте витрину из бота', 'Эта страница работает внутри Telegram. Откройте бота Chinor Park и нажмите кнопку меню.', 'Перейти на сайт'],
  uz: ['Vitrinani botdan oching', 'Bu sahifa Telegram ichida ishlaydi. Chinor Park botini oching va menyu tugmasini bosing.', 'Saytga o‘tish'],
  en: ['Open the showcase from the bot', 'This page works inside Telegram. Open the Chinor Park bot and press the menu button.', 'Go to the website']
};

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
  const lang = ['ru', 'uz', 'en'].includes(doc.documentElement.lang) ? doc.documentElement.lang : 'ru';
  const [title, text, link] = TEXT[lang];
  const box = doc.createElement('div');
  box.className = 'mini-outside';
  box.setAttribute('role', 'alert');
  box.innerHTML = '<h1></h1><p></p><a href="/"></a>';
  box.querySelector('h1').textContent = title;
  box.querySelector('p').textContent = text;
  box.querySelector('a').textContent = link;
  box.querySelector('a').href = `/${lang}`;
  doc.body.prepend(box);
}

export function startMini(win = window) {
  const doc = win.document;
  if (doc.documentElement.dataset.mode !== 'mini') return null;
  const tg = win.Telegram?.WebApp;
  const initData = tg?.initData ?? '';
  if (!initData) {
    if (doc.body) outside(doc); else doc.addEventListener('DOMContentLoaded', () => outside(doc), { once: true });
    return null;
  }
  const plain = win.fetch.bind(win);
  win.fetch = (input, init) => plain(...miniRequest(input, init, initData, win.location.origin));
  applyTheme(doc.documentElement, tg);
  tg.onEvent?.('themeChanged', () => applyTheme(doc.documentElement, tg));
  tg.ready?.();
  tg.expand?.();
  return tg;
}

if (typeof window !== 'undefined' && window.document) startMini(window);
