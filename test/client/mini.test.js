// public/js/mini.js (11 §8, 10 §7.3): X-Tg-Init-Data on the own /api requests, the hold and the payment renamed to /api/mini/*,
// the Telegram theme as variables and the Domus theme; an empty initData shows «Откройте витрину из бота».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { miniRequest, applyTheme, startMini } from '../../public/js/mini.js';

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

  const { document } = parseHTML('<html lang="ru" data-mode="mini"><body></body></html>');
  const calls = [], handlers = {};
  const tg = { initData: 'signed', colorScheme: 'dark', themeParams: {}, ready: () => calls.push('ready'), expand: () => calls.push('expand'),
    onEvent: (e, f) => { handlers[e] = f; } };
  const seen = [];
  const win = { document, Telegram: { WebApp: tg }, location: { origin: O }, fetch: (u, i) => seen.push([u, i?.headers?.get('x-tg-init-data')]) };
  startMini(win);
  assert.deepEqual(calls, ['ready', 'expand']);
  await win.fetch('/api/bookings/hold', { method: 'POST' });
  assert.deepEqual(seen, [['/api/mini/bookings/hold', 'signed']]);
  tg.colorScheme = 'light';
  handlers.themeChanged();
  assert.equal(document.documentElement.dataset.theme, 'light');

  const site = parseHTML('<html lang="ru"><body></body></html>');
  assert.equal(startMini({ document: site.document }), null, 'the site itself is left alone');
});
