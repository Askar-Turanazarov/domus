// 12 §4: the screens of bookings and payments — tabs with counts, rows, the card, the extend / cancel dialogs (one Idempotency-Key,
// the version the screen saw, a reason that cannot be empty, a stale screen), refund buttons for the head only, and server data
// going into the page as text.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div><div id="toast" hidden></div></body></html>');
globalThis.document = document;
globalThis.history = { replaceState() {} };
const MIN = 60e3;
const iso = ms => new Date(Date.now() + ms).toISOString();
const EVIL = '<img src=x onerror=alert(1)>';

const client = { id: 'c1', name: EVIL, phone: '+998 90 *** ** 67', telegramLinked: true };
const item = (no, status, extra = {}) => ({ no, status, channel: 'telegram', heldAt: iso(-60 * MIN), expiresAt: iso(5 * 60 * MIN), closedAt: null, version: 2, soon: false,
  deposit: 10e6, apartment: { no: 40 + no % 10, rooms: 2, floor: 5 }, client, payment: { code: 'P-7F3A', provider: 'card', cardBrand: 'HUMO', status: 'succeeded' }, assignee: 'Азиз', ...extra });
const lists = {
  active: { items: [item(1001, 'booked', { soon: true }), item(1002, 'booked')], next: null, counts: { active: 2, held: 1, soon: 1 } },
  closed: { items: [item(1003, 'expired', { closedAt: iso(-MIN) })], next: null, counts: { active: 2, held: 1, soon: 1 } }
};
const bookingCard = (booking = {}) => ({
  booking: { ...item(1001, 'booked', { soon: true }), bookedAt: iso(-50 * MIN), price: 1e9, consentAt: iso(-55 * MIN), extendedCount: 0, cancelInitiator: null, cancelReason: null,
    canExtend: true, canCancel: true, ...booking },
  apartment: { no: 41, rooms: 2, floor: 5, area: 60, price: 1e9 }, limits: { extendMaxHours: 168 },
  payments: [{ id: '11111111-1111-4111-8111-111111111111', code: 'P-7F3A', kind: 'deposit', provider: 'card', amount: 10e6, status: 'succeeded', failureReason: null,
    cardBrand: 'HUMO', cardMask: '9860 •••• 0001', createdAt: iso(-60 * MIN), succeededAt: iso(-50 * MIN), bookingNo: 1001, orderNo: null, refund: null, canRefund: false }],
  history: [{ id: 1, at: iso(-50 * MIN), type: 'booking.paid', actor: 'system', staff: null, bookingNo: 1001, data: {} }]
});

const calls = [];
let cardBody = bookingCard(), postAnswer = null;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  calls.push({ url: u, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
  const answer = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  if (init.method === 'POST') return postAnswer ?? answer({ booking: cardBody.booking });
  if (u.startsWith('/api/admin/bookings?')) {
    const tab = new URL(u, 'http://x').searchParams.get('tab');
    return answer({ ...lists[tab], at: new Date().toISOString() });
  }
  if (u.startsWith('/api/admin/bookings/')) return answer({ ...cardBody, at: new Date().toISOString() });
  throw new Error('unexpected ' + u);
};

const { mount } = await import('../../public/admin/views/bookings.js');
const tick = (ms = 25) => new Promise(r => setTimeout(r, ms));
let root, stop;
const posts = () => calls.filter(c => c.method === 'POST');
const submit = async () => { document.querySelector('.adm2-modal form').dispatchEvent(new window.Event('submit', { cancelable: true })); await tick(); };

before(async () => {
  root = document.getElementById('root');
  stop = mount(root, { staff: { role: 'manager' }, params: [] });
  await tick();
});
after(() => stop());

test('tabs with counts, a row per booking, the red mark of «burns soon», names as text', () => {
  const tabs = [...root.querySelectorAll('.adm2-tabs button')];
  assert.deepEqual(tabs.map(b => b.dataset.tab), ['active', 'held', 'soon', 'closed']);
  assert.match(tabs[0].textContent, /Активные\s*2/);
  assert.match(tabs[2].textContent, /Сгорают скоро\s*1/);
  assert.ok(tabs[0].className.includes('on'));
  const rows = [...root.querySelectorAll('tbody tr')];
  assert.equal(rows.length, 2);
  assert.ok(rows[0].className.includes('soon') && !rows[1].className.includes('soon'));
  assert.match(rows[0].textContent, /№1001/);
  assert.match(rows[0].textContent, /\+998 90 \*\*\* \*\* 67/);
  assert.match(rows[0].textContent, /HUMO · P-7F3A/);
  assert.ok(rows[0].textContent.includes(EVIL));
  assert.equal(root.querySelector('img'), null);
});

test('another tab asks the server for it and shows closed rows with their closing time', async () => {
  root.querySelector('[data-tab="closed"]').click();
  await tick();
  assert.match(calls.at(-1).url, /tab=closed/);
  const rows = root.querySelectorAll('tbody tr');
  assert.equal(rows.length, 1);
  assert.match(rows[0].textContent, /закрыта/);
  root.querySelector('[data-tab="active"]').click();
  await tick();
  assert.equal(root.querySelectorAll('tbody tr').length, 2);
});

test('the card: facts, payments with a mask, events, actions by the booking state', async () => {
  root.querySelector('tbody tr').click();
  await tick();
  const side = root.querySelector('.adm2-side');
  assert.equal(side.hidden, false);
  assert.match(side.textContent, /Бронь №1001/);
  assert.match(side.textContent, /9860 •••• 0001/);
  assert.match(side.textContent, /Депозит оплачен/);
  assert.ok(side.querySelector('[data-act="extend"]') && side.querySelector('[data-act="cancel"]') && side.querySelector('[data-act="link"]'));
  assert.ok(side.querySelector('a[href="#/payments/11111111-1111-4111-8111-111111111111"]'));
  assert.equal(side.querySelector('img'), null);
});

test('extend: the reason is required; one key; the version of the screen; success reloads', async () => {
  root.querySelector('[data-act="extend"]').click();
  assert.match(document.querySelector('.adm2-modal').textContent, /Продлить бронь №1001/);
  assert.match(document.querySelector('.adm2-modal').textContent, /168 ч/);
  await submit();
  assert.match(document.querySelector('.adm2-modal .adm2-err').textContent, /Причина/);
  assert.equal(posts().length, 0, 'nothing is sent without a reason');

  document.querySelector('.adm2-modal textarea').value = 'клиент в поездке';
  document.querySelector('.adm2-modal textarea').dispatchEvent(new window.Event('input'));
  document.querySelector('.adm2-modal input[value="48"]').click();
  await submit();
  const post = posts().at(-1);
  assert.equal(post.url, '/api/admin/bookings/1001/extend');
  assert.deepEqual(post.body, { hours: 48, reason: 'клиент в поездке', expectedVersion: 2 });
  assert.match(post.headers['Idempotency-Key'], /^[\w-]{8,64}$/);
  assert.equal(post.headers['X-Requested-With'], 'domus-admin');
  assert.equal(document.querySelector('.adm2-modal'), null, 'the dialog closed');
  assert.match(document.getElementById('toast').textContent, /Бронь продлена/);
});

test('a stale screen: the dialog closes, the card reloads, the person is told', async () => {
  postAnswer = { ok: false, status: 409, json: async () => ({ error: 'stale', message: 'Данные изменились', vars: { current: {} } }) };
  root.querySelector('[data-act="extend"]').click();
  document.querySelector('.adm2-modal textarea').value = 'ещё раз';
  document.querySelector('.adm2-modal textarea').dispatchEvent(new window.Event('input'));
  const before = calls.length;
  await submit();
  postAnswer = null;
  assert.equal(document.querySelector('.adm2-modal'), null);
  assert.match(document.getElementById('toast').textContent, /Бронь изменилась/);
  assert.ok(calls.slice(before).some(c => c.url === '/api/admin/bookings/1001' && c.method === 'GET'), 'the card is fetched again');
});

test('a server error stays in the dialog and keeps it open', async () => {
  postAnswer = { ok: false, status: 422, json: async () => ({ error: 'extend_too_long', message: 'Не дальше чем на 168 ч', vars: {} }) };
  root.querySelector('[data-act="extend"]').click();
  document.querySelector('.adm2-modal textarea').value = 'слишком долго';
  document.querySelector('.adm2-modal textarea').dispatchEvent(new window.Event('input'));
  await submit();
  postAnswer = null;
  assert.match(document.querySelector('.adm2-modal .adm2-err').textContent, /Не дальше чем на 168 ч/);
  document.querySelector('.adm2-modal [type="button"]').click();                       // Отмена
  assert.equal(document.querySelector('.adm2-modal'), null);
});

test('cancel: the initiator and the reason go with the version; a developer cancel says the refund started', async () => {
  root.querySelector('[data-act="cancel"]').click();
  const modal = document.querySelector('.adm2-modal');
  assert.match(modal.textContent, /депозит вернётся автоматически/);
  assert.deepEqual([...modal.querySelectorAll('input[type="radio"]')].map(r => r.value), ['client', 'developer']);
  modal.querySelector('input[value="developer"]').click();
  modal.querySelector('textarea').value = 'ошибка в цене';
  modal.querySelector('textarea').dispatchEvent(new window.Event('input'));
  postAnswer = { ok: true, status: 200, json: async () => ({ booking: cardBody.booking, refund: { id: 'r1', status: 'pending', reason: 'developer_cancel' } }) };
  await submit();
  postAnswer = null;
  const post = posts().at(-1);
  assert.equal(post.url, '/api/admin/bookings/1001/cancel');
  assert.deepEqual(post.body, { initiator: 'developer', reason: 'ошибка в цене', expectedVersion: 2 });
  assert.match(document.getElementById('toast').textContent, /возврат депозита запущен/);
});

test('a closed booking has no extend / cancel; a held one can only be cancelled by the developer', async () => {
  cardBody = bookingCard({ status: 'expired', canExtend: false, canCancel: false });
  root.querySelector('.adm2-side-head button').click();                                    // close the card
  root.querySelector('tbody tr').click();
  await tick();
  assert.equal(root.querySelector('[data-act="extend"]'), null);
  assert.equal(root.querySelector('[data-act="cancel"]'), null);
  assert.ok(root.querySelector('[data-act="link"]'));

  cardBody = bookingCard({ status: 'held', canExtend: false, canCancel: true });
  root.querySelector('.adm2-side-head button').click();
  root.querySelector('tbody tr').click();
  await tick();
  assert.equal(root.querySelector('[data-act="extend"]'), null);
  root.querySelector('[data-act="cancel"]').click();
  assert.deepEqual([...document.querySelectorAll('.adm2-modal input[type="radio"]')].map(r => r.value), ['developer']);
  document.querySelector('.adm2-modal [type="button"]').click();
});
