// 12 §9: the dashboard screen — tiles, funnel, charts, the mini board, the AI banner, the live feed (3 s, dedupe, 50 rows, highlight), the immediate
// reload on a money event (PERF-07), the period switch, the manager's trimmed view; server text stays text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div><div id="toast" hidden></div></body></html>');
globalThis.document = document;
globalThis.history = { replaceState() {} };
const EVIL = '<img src=x onerror=alert(1)>';

const hours = Array.from({ length: 24 }, (_, h) => ({ day: '2026-10-28', hour: h }));
const days = Array.from({ length: 7 }, (_, i) => ({ day: `2026-10-${String(22 + i).padStart(2, '0')}` }));
const summaryOf = (over = {}) => ({
  period: { name: 'today', from: '2026-10-28', to: '2026-10-28' },
  tiles: { sold: { count: 19, sum: 15_400_000_000 }, booked: { count: 17, sum: 13_100_000_000 }, deposits: { count: 17, sum: 170_000_000 },
    free: { count: 56, total: 92, held: 1 }, burning: { count: 3 } },
  funnel: { visitors: 2840, dialogs: 412, bookings: 41, paid: 29, sales: 19 },
  conversions: { visitorToDialog: 0.145, dialogToBooking: 0.2, bookingToSale: 0.655, expiredShare: 0.1, medianFirstMessageToBookingMin: 135, handoffShare: null },
  ai: { turns: 80, toolCalls: 120, errors: 2, fallbacks: 1, up: 5, down: 1, unanswered: 4, mode: 'reserve', costUsd: 0.5, gemini: [{ model: 'gemini-3.6-flash', used: 214, limit: 1500 }] },
  compare: { sold: { prev: 10, pct: 90 }, deposits: { prev: 200_000_000, pct: -15 } },
  ...over
});
const chartsOf = (step = 'hour') => ({
  step,
  deposits: (step === 'hour' ? hours : days).map((p, i) => ({ ...p, amount: i === 3 ? 20_000_000 : i === 4 ? -5_000_000 : 0 })),
  bookings: (step === 'hour' ? hours : days).map((p, i) => ({ ...p, held: i % 3, paid: i % 2 })),
  byType: [0, 1, 2, 3, 4].map(rooms => ({ rooms, sold: 2, booked: 3, held: 1, free: 10 }))
});
const units = () => ({ units: Array.from({ length: 24 }, (_, i) => ({ no: i + 1, floor: 1 + Math.floor(i / 8), rooms: 1, area: 40, price: 1, status: i === 0 ? 'sold' : i === 1 ? 'booked' : 'free', soon: i === 1 })) });

let S, calls, feedPages;
function reset(over = {}) {
  S = { summary: summaryOf(), charts: chartsOf(), units: units(), ...over };
  calls = [];
  feedPages = [];
}
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  calls.push(u);
  const ok = body => ({ ok: true, status: 200, json: async () => body });
  if (u.startsWith('/api/dashboard/summary')) return ok(typeof S.summary === 'function' ? S.summary(u) : S.summary);
  if (u.startsWith('/api/dashboard/charts')) return ok(typeof S.charts === 'function' ? S.charts(u) : S.charts);
  if (u === '/api/admin/units') return ok(typeof S.units === 'function' ? S.units() : S.units);
  if (u.startsWith('/api/dashboard/feed')) {
    const page = feedPages.length > 1 ? feedPages.shift() : (feedPages[0] ?? { items: [], last: 0 });
    if (page instanceof Error) throw page;
    return ok(page);
  }
  throw new Error('unexpected ' + (init.method ?? 'GET') + ' ' + u);
};

const { mount, FEED_MS, SUMMARY_MS, moneyShort } = await import('../../public/dashboard/dashboard.js');
const { barChart, niceMax } = await import('../../public/dashboard/charts.js');
const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));
const row = (id, type = 'booking.held', text = `Удержание №${id}`, extra = {}) => ({ id, type, at: '2026-10-28T13:04:00+05:00', text, link: `/admin#/bookings/${id}`, ...extra });
const count = (root, name) => calls.filter(c => c.startsWith('/api/dashboard/' + name)).length;

async function open(t, role = 'head', opts = {}) {
  const root = document.createElement('div');
  document.body.append(root);
  const stop = mount(root, { staff: { role }, feedMs: 25, summaryMs: 100000, ...opts });
  t.after(() => { stop(); root.remove(); });
  await tick();
  return root;
}
const tile = (root, id) => root.querySelector(`[data-tile="${id}"]`);

test('the poll is every 3 s and the summary every 30 s (PERF-07: poll + request < 5 s)', () => {
  assert.equal(FEED_MS, 3000);
  assert.equal(SUMMARY_MS, 30000);
  assert.ok(FEED_MS < 5000);
});

test('head: the five tiles with short money, the exact value in the title, compare arrows, free of total', async t => {
  reset();
  const root = await open(t);
  assert.equal(tile(root, 'sold').textContent, '19');
  assert.match(tile(root, 'sold').parentNode.textContent, /15,4 млрд сум/);
  assert.match(tile(root, 'sold').parentNode.textContent, /▲ 90%/);
  assert.equal(tile(root, 'booked').textContent, '17');
  assert.match(tile(root, 'deposits').textContent, /170 млн сум/);
  assert.match(tile(root, 'deposits').title, /170\s?000\s?000/);
  assert.match(tile(root, 'deposits').parentNode.textContent, /▼ 15%/);
  assert.match(tile(root, 'free').textContent, /56 из 92/);
  assert.match(tile(root, 'free').parentNode.textContent, /\+1 на оплате/);
  assert.equal(tile(root, 'burning').textContent, '3');
  assert.equal(moneyShort(9_500_000), '9,5 млн сум');
  assert.equal(moneyShort(500_000).replace(/\s/g, ' '), '500 000 сум');
});

test('the funnel: five steps, proportional bars, the conversions with a dash for no data, the median in minutes', async t => {
  reset();
  const root = await open(t);
  assert.deepEqual([...root.querySelectorAll('[data-step]')].map(n => n.dataset.step), ['visitors', 'dialogs', 'bookings', 'paid', 'sales']);
  assert.equal(root.querySelector('[data-step="visitors"] i').dataset.pct, '100');
  assert.equal(root.querySelector('[data-step="sales"] i').dataset.pct, '1');
  assert.match(root.querySelector('[data-conv="visitorToDialog"]').textContent, /14,5%/);
  assert.match(root.querySelector('[data-conv="handoffShare"]').textContent, /—/);
  assert.match(root.querySelector('[data-conv="median"]').textContent, /135 мин/);
  assert.match(root.textContent, /по удержаниям, начатым за период/);
});

test('charts: bars per hour with the negative one marked, two lines, five rows of the cut by rooms, the tip on a tap', async t => {
  reset();
  const root = await open(t);
  const dep = root.querySelector('[data-chart="deposits"]');
  assert.equal(dep.querySelectorAll('rect.dsh-bar').length, 24);
  assert.equal(dep.querySelectorAll('rect.neg').length, 1);
  const hit = dep.querySelectorAll('.dsh-hit')[3];
  assert.match(hit.getAttribute('data-tip'), /03:00/);
  hit.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(dep.querySelector('.dsh-tip').hidden, false);
  assert.match(dep.querySelector('.dsh-tip').textContent, /20 000 000|20\s000\s000/);
  const book = root.querySelector('[data-chart="bookings"]');
  assert.equal(book.querySelectorAll('path.dsh-line').length, 2);
  assert.ok(book.querySelector('path.dsh-line.held') && book.querySelector('path.dsh-line.paid'));
  const types = root.querySelector('[data-chart="byType"]');
  assert.equal(types.querySelectorAll('.dsh-hit').length, 5);
  assert.equal(types.querySelectorAll('rect.seg-free').length, 5);
  assert.match(types.textContent, /Студия/);
});

test('charts.js: nice tops of the scale and a bar chart with no data stays drawn', () => {
  assert.deepEqual([0, 0.7, 1.3, 2.2, 4, 7, 80].map(niceMax), [1, 1, 2, 2.5, 5, 10, 100]);
  const box = barChart([{ label: 'a', value: 0, tip: 'x' }, { label: 'b', value: 0, tip: 'y' }], { label: 'empty' });
  assert.equal(box.querySelectorAll('rect.dsh-bar').length, 2);
  assert.equal(box.querySelector('svg').getAttribute('aria-label'), 'empty');
});

test('the mini board: a floor per row, the cell colours and links, the AI banner and the Gemini bar', async t => {
  reset();
  const root = await open(t);
  assert.equal(root.querySelectorAll('.dsh-floor').length, 3);
  assert.equal(root.querySelectorAll('.dsh-cell').length, 24);
  assert.equal(root.querySelector('.dsh-cell[data-no="1"]').dataset.status, 'sold');
  assert.ok(root.querySelector('.dsh-cell[data-no="2"]').classList.contains('soon'));
  assert.equal(root.querySelector('.dsh-cell[data-no="3"]').getAttribute('href'), '/admin/#/units/3');
  assert.match(root.querySelector('.dsh-ai').textContent, /ИИ: ● резерв/);
  assert.ok(root.querySelector('.dsh-ai').classList.contains('warn'));
  assert.equal(root.querySelector('.dsh-ai').getAttribute('href'), '/admin/#/system/services');
  assert.match(root.querySelector('[data-act="gemini"]').textContent, /запросов сегодня 214 из 1\s500/);
  assert.equal(root.querySelector('[data-act="cost"]').textContent.replace(/\s/g, ''), 'Расход,$0,5'.replace(/\s/g, ''));
});

test('manager: no sold, deposits tiles, no deposits chart, no money in the AI block, a banner that is not a link', async t => {
  reset({ summary: summaryOf({ tiles: { booked: { count: 17 }, free: { count: 56, total: 92, held: 0 }, burning: { count: 3 } }, compare: undefined,
    ai: { turns: 80, toolCalls: 120, errors: 2, fallbacks: 1, up: 5, down: 1, unanswered: 4, mode: 'primary' } }), charts: { ...chartsOf(), deposits: undefined } });
  const root = await open(t, 'manager');
  assert.equal(tile(root, 'sold'), null);
  assert.equal(tile(root, 'deposits'), null);
  assert.equal(tile(root, 'booked').textContent, '17');
  assert.equal(root.querySelector('[data-chart="deposits"]'), null);
  assert.equal(root.querySelector('[data-act="cost"]'), null);
  assert.equal(root.querySelector('.dsh-ai').getAttribute('href'), null);
  assert.ok(root.querySelector('.dsh-ai').classList.contains('ok'));
  assert.equal(root.querySelector('.dsh-cmp.up'), null);
});

test('the feed: rows newest first with time, icon and a link; first load without highlight; later rows highlighted; repeats dropped by id', async t => {
  reset();
  feedPages = [{ items: [row(3, 'booking.paid', 'Бронь №3 оплачена'), row(2, 'booking.held')], last: 3 }, { items: [row(4, 'viewing.created', EVIL), row(3, 'booking.paid', 'Бронь №3 оплачена')], last: 4 }];
  const root = await open(t);
  let rows = [...root.querySelectorAll('.dsh-row')];
  assert.deepEqual(rows.map(r => r.dataset.id), ['4', '3', '2']);
  assert.ok(rows[0].classList.contains('new'));
  assert.ok(!rows[1].classList.contains('new'));
  assert.match(rows[1].textContent, /13:04/);
  assert.match(rows[1].textContent, /●/);
  assert.equal(rows[1].querySelector('a').getAttribute('href'), '/admin#/bookings/3');
  assert.ok(rows[0].textContent.includes(EVIL));
  assert.equal(root.querySelector('.dsh-feed img'), null);
  assert.ok(calls.some(c => c === '/api/dashboard/feed?after=0'));
  assert.ok(calls.some(c => c === '/api/dashboard/feed?after=3'));
});

test('the feed keeps 50 rows and says so when empty', async t => {
  reset();
  feedPages = [{ items: [], last: 0 }];
  const root = await open(t);
  assert.match(root.querySelector('.dsh-feed').textContent, /Событий пока нет/);
  feedPages = [{ items: Array.from({ length: 60 }, (_, i) => row(100 - i)), last: 100 }];
  await tick(80);
  assert.equal(root.querySelectorAll('.dsh-row').length, 50);
  assert.equal(root.querySelector('.dsh-row').dataset.id, '100');
});

test('PERF-07: a paid booking in the feed reloads the summary and the charts at once and the tile shows the new number', async t => {
  reset();
  feedPages = [{ items: [row(1)], last: 1 }];
  const root = await open(t);
  const before = { summary: count(root, 'summary'), charts: count(root, 'charts') };
  S.summary = summaryOf({ tiles: { ...summaryOf().tiles, booked: { count: 18, sum: 13_900_000_000 }, deposits: { count: 18, sum: 180_000_000 } } });
  feedPages = [{ items: [row(2, 'booking.paid', 'Бронь №2 оплачена · CARD · 10 000 000 сум')], last: 2 }];
  await tick(120);
  assert.equal(root.querySelector('.dsh-row').dataset.id, '2');
  assert.equal(count(root, 'summary'), before.summary + 1);
  assert.equal(count(root, 'charts'), before.charts + 1);
  assert.equal(tile(root, 'booked').textContent, '18');
  assert.match(tile(root, 'deposits').textContent, /180 млн сум/);
});

test('a non-money event does not reload the numbers; the 30 s summary does', async t => {
  reset();
  feedPages = [{ items: [row(1)], last: 1 }];
  const root = await open(t, 'head', { summaryMs: 70 });
  const n = count(root, 'summary');
  feedPages = [{ items: [row(2, 'booking.held')], last: 2 }];
  await tick(30);
  assert.equal(root.querySelector('.dsh-row').dataset.id, '2');
  await tick(150);
  assert.ok(count(root, 'summary') > n);
  assert.equal(count(root, 'charts'), 1);
});

test('the period switch asks the server for that period, marks the button and redraws the day axis', async t => {
  reset({ summary: u => summaryOf({ period: { name: new URL(u, 'http://x').searchParams.get('period') } }), charts: u => chartsOf(u.includes('period=today') ? 'hour' : 'day') });
  const root = await open(t);
  assert.ok(calls.includes('/api/dashboard/summary?period=today'));
  root.querySelector('[data-period="7d"]').click();
  await tick();
  assert.ok(calls.includes('/api/dashboard/summary?period=7d'));
  assert.ok(calls.includes('/api/dashboard/charts?period=7d'));
  assert.ok(root.querySelector('[data-period="7d"]').classList.contains('on'));
  assert.ok(!root.querySelector('[data-period="today"]').classList.contains('on'));
  assert.equal(root.querySelector('[data-chart="deposits"]').querySelectorAll('rect.dsh-bar').length, 7);
  assert.match(root.querySelector('[data-chart="deposits"]').textContent, /22\.10/);
});

test('a failed poll shows «no connection» and the next good one clears it', async t => {
  reset();
  feedPages = [new Error('offline'), { items: [row(1)], last: 1 }];
  const root = await open(t, 'head', { feedMs: 60 });
  assert.equal(root.querySelector('.dsh-offline').hidden, false);
  await tick(150);
  assert.equal(root.querySelector('.dsh-offline').hidden, true);
  assert.equal(root.querySelector('.dsh-row').dataset.id, '1');
});

test('stop() ends the polling', async t => {
  reset();
  const root = document.createElement('div');
  document.body.append(root);
  const stop = mount(root, { staff: { role: 'head' }, feedMs: 20, summaryMs: 100000 });
  await tick(60);
  stop();
  const n = count(root, 'feed');
  await tick(100);
  assert.equal(count(root, 'feed'), n);
});
