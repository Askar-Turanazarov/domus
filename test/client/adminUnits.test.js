// 12 §3 (FR-ADM-03): the chessboard screen — floors from the top, status classes, the red mark of «burns within 24 h», filters
// that dim, the card on a click, and server data going into the page as text only (no HTML from a client's name).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div><div id="toast" hidden></div></body></html>');
globalThis.document = document;
globalThis.history = { replaceState() {} };
const MIN = 60e3;
const at = new Date('2026-10-28T10:00:00Z');
const iso = ms => new Date(at.getTime() + ms).toISOString();

const units = [
  { no: 1, floor: 1, rooms: 2, area: 60, price: 900e6, status: 'free', soon: false },
  { no: 2, floor: 2, rooms: 0, area: 28, price: 340e6, status: 'held', soon: false, bookingNo: 1001, expiresAt: iso(14 * MIN) },
  { no: 3, floor: 2, rooms: 3, area: 80, price: 1e9, status: 'booked', soon: true, bookingNo: 1002, expiresAt: iso(5 * 60 * MIN) },
  { no: 4, floor: 1, rooms: 1, area: 40, price: 500e6, status: 'sold', soon: false }
];
const EVIL = '<img src=x onerror=alert(1)>';
const card = {
  apartment: { no: 3, floor: 2, rooms: 3, area: 80, price: 1e9, status: 'booked', version: 1, soldAt: null, soldNote: null },
  booking: { no: 1002, status: 'booked', channel: 'web', heldAt: iso(-60 * MIN), bookedAt: iso(-50 * MIN), closedAt: null, expiresAt: iso(5 * 60 * MIN),
    deposit: 10e6, price: 1e9, cancelInitiator: null, cancelReason: null, version: 2, client: { id: 'c1', name: EVIL, phone: '+998 90 *** ** 67', telegramLinked: false } },
  bookings: [], viewings: [],
  history: [{ id: 1, at: iso(-50 * MIN), type: 'booking.paid', actor: 'system', staff: null, bookingNo: 1002, data: {} }]
};
const answer = body => ({ ok: true, status: 200, json: async () => body });
globalThis.fetch = async url => {
  if (String(url).endsWith('/api/admin/units')) return answer({ units, at: at.toISOString() });
  if (String(url).includes('/api/admin/apartments/')) return answer(card);
  throw new Error('unexpected ' + url);
};
globalThis.Date = class extends Date {   // the screen counts time left from the server's clock
  static now() { return at.getTime(); }
};

const { mount } = await import('../../public/admin/views/units.js');
const tick = () => new Promise(r => setTimeout(r, 25));
let root, stop;

before(async () => {
  root = document.getElementById('root');
  stop = mount(root, { params: [] });
  await tick();
});
after(() => stop());

const cells = () => [...root.querySelectorAll('.adm2-cell')];
const cell = no => root.querySelector(`.adm2-cell[data-no="${no}"]`);

test('floors from the top, every apartment a cell with its status', () => {
  assert.deepEqual([...root.querySelectorAll('.adm2-floor-n')].map(n => n.textContent), ['Этаж 2', 'Этаж 1']);
  assert.equal(cells().length, 4);
  assert.ok(cell(1).className.includes('st-free'));
  assert.ok(cell(2).className.includes('st-held'));
  assert.ok(cell(3).className.includes('st-booked'));
  assert.ok(cell(4).className.includes('st-sold'));
});

test('time left on held / booked cells, the red mark only on «burns within 24 h»', () => {
  assert.match(cell(2).textContent, /14 мин/);
  assert.match(cell(3).textContent, /5 ч/);
  assert.ok(cell(3).className.includes('soon'));
  assert.ok(!cell(2).className.includes('soon'));
  assert.ok(!/мин|ч\b/.test(cell(1).querySelector('em')?.textContent ?? ''));
});

test('a status filter dims the other cells; reset brings them back', () => {
  const chip = [...root.querySelectorAll('.adm2-chip')].find(c => c.textContent === 'Забронирована');
  chip.click();
  assert.deepEqual(cells().filter(c => c.className.includes('dim')).map(c => c.dataset.no).sort(), ['1', '2', '4']);
  assert.match(root.querySelector('.adm2-info').textContent, /Показано 1 из 4/);
  [...root.querySelectorAll('button')].find(b => b.textContent === 'Сбросить').click();
  assert.equal(cells().filter(c => c.className.includes('dim')).length, 0);
});

test('a click opens the card; a client name stays text; a second click closes it', async () => {
  cell(3).click();
  await tick();
  const side = root.querySelector('.adm2-side');
  assert.equal(side.hidden, false);
  assert.match(side.textContent, /Квартира №3/);
  assert.match(side.textContent, /№1002/);
  assert.ok(side.textContent.includes(EVIL), 'the name is shown as it is');
  assert.equal(side.querySelector('img'), null, 'and never becomes an element');
  assert.match(side.textContent, /\+998 90 \*\*\* \*\* 67/);
  assert.match(side.textContent, /Депозит/);
  assert.match(side.textContent, /Депозит оплачен/);
  cell(3).click();
  assert.equal(root.querySelector('.adm2-side').hidden, true);
});
