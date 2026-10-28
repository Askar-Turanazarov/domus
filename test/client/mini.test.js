// public/js/mini.js (11 §8, 10 §7.3): X-Tg-Init-Data on the own /api requests, the hold and the payment renamed to /api/mini/*,
// the Telegram theme as variables and the Domus theme; an empty initData shows «Откройте витрину из бота».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { miniRequest, applyTheme, startMini, continueMini, mainAction } from '../../public/js/mini.js';

const O = 'https://domus.test';

test('the header on own /api calls, the two public entries go to /api/mini; others untouched', () => {
  const [u1, i1] = miniRequest('/api/bookings/hold', { method: 'POST', headers: { 'Idempotency-Key': 'k1234567' } }, 'tg', O);
  assert.equal(u1, '/api/mini/bookings/hold');
  assert.equal(i1.headers.get('x-tg-init-data'), 'tg');
  assert.equal(i1.headers.get('idempotency-key'), 'k1234567');
  assert.equal(miniRequest('/api/payments', { method: 'post' }, 'tg', O)[0], '/api/mini/payments');
  assert.equal(miniRequest('/api/payments/abc', { method: 'POST' }, 'tg', O)[0], '/api/payments/abc');
  const [u3, i3] = miniRequest('/api/apartments/status?x=1', undefined, 'tg', O);
  assert.deepEqual([u3, i3.headers.get('x-tg-init-data')], ['/api/apartments/status?x=1', 'tg']);
  const ext = miniRequest('https://other.test/api/x', {}, 'tg', O);
  assert.deepEqual(ext, ['https://other.test/api/x', {}], 'never to another origin');
  assert.deepEqual(miniRequest('/css/a.css', {}, 'tg', O), ['/css/a.css', {}]);
});

test('themeParams → --tg-*; colorScheme → data-theme', () => {
  const { document } = parseHTML('<html><body></body></html>');
  const root = document.documentElement;
  applyTheme(root, { colorScheme: 'light', themeParams: { bg_color: '#ffffff', button_color: '#2481cc' } });
  assert.equal(root.dataset.theme, 'light');
  assert.equal(root.style.getPropertyValue('--tg-bg'), '#ffffff');
  assert.equal(root.style.getPropertyValue('--tg-button'), '#2481cc');
  applyTheme(root, { colorScheme: 'dark', themeParams: {} });
  assert.equal(root.dataset.theme, 'dark');
});

test('outside Telegram the page says to open it from the bot; inside — ready, expand, the fetch wrapper, themeChanged', async () => {
  const out = parseHTML('<html lang="en" data-mode="mini"><body></body></html>');
  assert.equal(startMini({ document: out.document, Telegram: { WebApp: { initData: '' } }, fetch: () => {} }), null);
  assert.match(out.document.querySelector('.mini-outside h1').textContent, /Open the showcase from the bot/);

  const { win, tg, calls, handlers, seen, storage } = fakeTelegram(SHOWCASE);
  startMini(win);
  assert.deepEqual(calls.slice(0, 2), ['ready', 'expand']);
  assert.equal(storage.get('domus.mini'), '1', 'the pages opened from here keep the mode');
  await win.fetch('/api/bookings/hold', { method: 'POST' });
  assert.deepEqual(seen, [['/api/mini/bookings/hold', 'signed']]);
  tg.colorScheme = 'light';
  handlers.themeChanged();
  assert.equal(win.document.documentElement.dataset.theme, 'light');
  assert.ok(win.document.querySelector('.mini-mine-btn'), '«Мои брони» on the showcase');

  const site = parseHTML('<html lang="ru"><body></body></html>');
  assert.equal(startMini({ document: site.document }), null, 'the site itself is left alone');
});

const SHOWCASE = `<html lang="ru" data-mode="mini"><body>
  <dialog id="aptDlg"><h2 id="aptTitle">Квартира №41 · 2-комн.</h2><button id="aptBook" class="btn primary">🏠 Забронировать</button>
    <a id="aptContinue" class="btn primary" hidden>Продолжить</a></dialog>
  <dialog id="holdDlg"><form id="holdForm"><button type="submit" id="holdGo" class="btn primary" disabled>Оформить</button></form></dialog>
</body></html>`;

function fakeTelegram(html, { initData = 'signed' } = {}) {
  const w = parseHTML(html);
  const calls = [], handlers = {}, seen = [], storage = new Map(), main = {}, back = {};
  const tg = { initData, colorScheme: 'dark', themeParams: {}, ready: () => calls.push('ready'), expand: () => calls.push('expand'),
    onEvent: (e, f) => { handlers[e] = f; },
    MainButton: { setText: s => { main.text = s; }, show: () => { main.shown = true; }, hide: () => { main.shown = false; },
      enable: () => { main.enabled = true; }, disable: () => { main.enabled = false; }, onClick: f => { main.click = f; } },
    BackButton: { show: () => { back.shown = true; }, hide: () => { back.shown = false; }, onClick: f => { back.click = f; } },
    HapticFeedback: { notificationOccurred: k => calls.push(`haptic:${k}`) } };
  const win = { document: w.document, Telegram: { WebApp: tg }, location: { origin: O, search: '' }, MutationObserver: w.MutationObserver,
    setTimeout, history: { back: () => calls.push('history.back') },
    sessionStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    fetch: async (u, i) => { seen.push([u, i?.headers?.get('x-tg-init-data')]); return { ok: true, json: async () => ({ items: [] }) }; } };
  return { win, tg, calls, handlers, seen, storage, main, back };
}

test('MainButton is the main action: «Забронировать №41» on the card, the form button while the form is open (disabled with it)', () => {
  const { document } = parseHTML(SHOWCASE);
  assert.equal(mainAction(document), null, 'nothing open — no main button');
  document.getElementById('aptDlg').setAttribute('open', '');
  assert.deepEqual((({ label, enabled }) => ({ label, enabled }))(mainAction(document)), { label: 'Забронировать №41', enabled: true });
  document.getElementById('aptBook').hidden = true;
  document.getElementById('aptContinue').hidden = false;
  assert.equal(mainAction(document).label, 'Продолжить');
  document.getElementById('holdDlg').setAttribute('open', '');
  assert.deepEqual((({ label, enabled }) => ({ label, enabled }))(mainAction(document)), { label: 'Оформить', enabled: false });
  const page = parseHTML('<html><body><main><a class="btn">Назад</a><a class="btn primary">💳 Оплатить</a></main></body></html>');
  assert.equal(mainAction(page.document).label, 'Оплатить', 'the booking page: «Оплатить»');
});

test('the buttons: MainButton clicks the action; BackButton closes the open dialog on the showcase, goes back elsewhere', async () => {
  const { win, main, back } = fakeTelegram(SHOWCASE);
  const book = win.document.getElementById('aptBook');
  let clicked = 0;
  book.addEventListener('click', () => clicked++);
  win.document.getElementById('aptDlg').setAttribute('open', '');
  win.document.getElementById('aptDlg').close = function () { this.removeAttribute('open'); };
  startMini(win);
  assert.deepEqual([main.text, main.shown, back.shown], ['Забронировать №41', true, true]);
  main.click();
  assert.equal(clicked, 1);
  back.click();
  assert.equal(win.document.getElementById('aptDlg').hasAttribute('open'), false);
  assert.deepEqual([main.shown, back.shown], [false, false], 'the showcase itself: no back, no main');
});

test('a page opened from the mini app keeps the mode by the flag; without the flag or without initData — the plain site', async () => {
  const page = '<html lang="ru"><body><main><button class="btn primary">Оплатить</button></main></body></html>';
  const plain = fakeTelegram(page);
  assert.equal(continueMini(plain.win), null, 'no flag — nothing happens');

  const { win, storage, seen, main, back, calls } = fakeTelegram(page);
  storage.set('domus.mini', '1');
  win.location.search = '?paid=1';
  const tg = await continueMini(win);
  assert.ok(tg);
  assert.equal(win.document.documentElement.dataset.mode, 'mini');
  await win.fetch('/api/payments', { method: 'POST' });
  assert.deepEqual(seen.at(-1), ['/api/mini/payments', 'signed']);
  assert.deepEqual([main.text, back.shown], ['Оплатить', true]);
  assert.ok(calls.includes('haptic:success'), 'paid → haptic');

  const gone = fakeTelegram(page, { initData: '' });
  gone.storage.set('domus.mini', '1');
  assert.equal(await continueMini(gone.win), null);
  assert.equal(gone.storage.has('domus.mini'), false);
  assert.equal(gone.win.document.documentElement.dataset.mode, undefined);
});
