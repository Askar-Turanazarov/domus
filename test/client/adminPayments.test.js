// 12 §4.2: the screen of payments — the list with filters and the total over the filter, the card with refunds, the refund buttons
// for the head only (a reason is required), a failed refund can be repeated, card numbers appear nowhere.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div><div id="toast" hidden></div></body></html>');
globalThis.document = document;
globalThis.history = { replaceState() {} };
const EVIL = '<img src=x onerror=alert(1)>';
const ID = '22222222-2222-4222-8222-222222222222';

const row = (id, code, status, extra = {}) => ({ id, code, kind: 'deposit', provider: 'card', amount: 10e6, status, failureReason: null, cardBrand: 'HUMO', cardMask: '9860 •••• 0001',
  createdAt: new Date().toISOString(), succeededAt: null, bookingNo: 1001, orderNo: null, refund: null, client: { id: 'c1', name: EVIL, phone: '+998 90 *** ** 67', telegramLinked: false }, ...extra });
const list = { items: [row(ID, 'P-7F3A', 'succeeded'), row('33333333-3333-4333-8333-333333333333', 'P-9B21', 'failed', { failureReason: 'bank_declined', cardBrand: null, cardMask: null, provider: 'click' })],
  next: null, totals: { count: 2, succeededCount: 1, succeededAmount: 10e6 } };
let cardBody;
const paymentCard = (extra = {}) => ({ payment: { ...row(ID, 'P-7F3A', 'succeeded'), expiresAt: null, currency: 'UZS' }, canRefund: true, retryRefundId: null, refunds: [], attempts: [], providerEvents: [], ...extra });

const calls = [];
let postAnswer = null;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  calls.push({ url: u, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
  const answer = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  if (init.method === 'POST') return postAnswer ?? answer({ refundId: 'r1' }, 201);
  if (u.startsWith('/api/admin/payments?')) return answer({ ...list, at: new Date().toISOString() });
  if (u.startsWith('/api/admin/payments/')) return answer({ ...cardBody, at: new Date().toISOString() });
  throw new Error('unexpected ' + u);
};

const { mount } = await import('../../public/admin/views/payments.js');
const tick = (ms = 25) => new Promise(r => setTimeout(r, ms));
const submit = async () => { document.querySelector('.adm2-modal form').dispatchEvent(new window.Event('submit', { cancelable: true })); await tick(); };
const posts = () => calls.filter(c => c.method === 'POST');

async function open(t, role) {
  cardBody = paymentCard();
  const root = document.createElement('div');
  document.body.append(root);
  const stop = mount(root, { staff: { role }, params: [] });
  await tick();
  t.after(stop);
  return { root };
}

test('the list: a row per payment, brand and mask or the provider, the reason of a failure, the total over the filter, names as text', async t => {
  const { root } = await open(t, 'manager');
  const rows = [...root.querySelectorAll('tbody tr')];
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /P-7F3A/);
  assert.match(rows[0].textContent, /Бронь №1001/);
  assert.match(rows[0].textContent, /HUMO 9860 •••• 0001/);
  assert.match(rows[0].textContent, /10 000 000 сум/);
  assert.match(rows[1].textContent, /Click/);
  assert.match(rows[1].textContent, /Банк отклонил/);
  assert.match(root.querySelector('.adm2-total').textContent, /Успешно: 1 · 10 000 000 сум/);
  assert.ok(rows[0].textContent.includes(EVIL));
  assert.equal(root.querySelector('img'), null);
});

test('a filter goes to the server', async t => {
  const { root } = await open(t, 'manager');
  const sel = root.querySelector('select[name="provider"]');
  sel.querySelector('option[value="click"]').selected = true;
  sel.dispatchEvent(new window.Event('change'));
  await tick();
  assert.match(calls.at(-1).url, /provider=click/);
  const from = root.querySelector('input[name="from"]');
  from.value = '2026-10-28';
  from.dispatchEvent(new window.Event('change'));
  await tick();
  assert.match(calls.at(-1).url, /from=2026-10-28/);
});

test('a manager sees the card but not the refund button; the card has no card number', async t => {
  const { root } = await open(t, 'manager');
  root.querySelector('tbody tr').click();
  await tick();
  const side = root.querySelector('.adm2-side');
  assert.match(side.textContent, /Платёж P-7F3A/);
  assert.equal(side.querySelector('[data-act="refund"]'), null);
  assert.match(side.textContent, /Возвраты делает только руководитель/);
  assert.ok(side.querySelector('a[href="#/bookings/1001"]'));
  assert.ok(!/\d{4} \d{4} \d{4} \d{4}/.test(side.textContent));
});

test('the head: a refund needs a reason, names the client and the sum, sends one key', async t => {
  const { root } = await open(t, 'head');
  root.querySelector('tbody tr').click();
  await tick();
  root.querySelector('[data-act="refund"]').click();
  const modal = document.querySelector('.adm2-modal');
  assert.match(modal.textContent, /Вернуть 10 000 000 сум клиенту/);
  await submit();
  assert.match(document.querySelector('.adm2-modal .adm2-err').textContent, /Причина/);
  assert.equal(posts().length, 0);

  modal.querySelector('textarea').value = 'решение руководителя';
  modal.querySelector('textarea').dispatchEvent(new window.Event('input'));
  await submit();
  const post = posts().at(-1);
  assert.equal(post.url, `/api/admin/payments/${ID}/refund`);
  assert.deepEqual(post.body, { reason: 'решение руководителя' });
  assert.match(post.headers['Idempotency-Key'], /^[\w-]{8,64}$/);
  assert.match(document.getElementById('toast').textContent, /Возврат запущен/);
  assert.equal(document.querySelector('.adm2-modal'), null);
});

test('a failed refund shows its reason and can be repeated', async t => {
  cardBody = paymentCard({ canRefund: false, retryRefundId: 'rf-1', refunds: [{ id: 'rf-1', status: 'failed', reason: 'developer_cancel', note: null,
    failure: 'manual_required', amount: 10e6, createdAt: new Date().toISOString(), completedAt: null, by: 'system' }] });
  const root = document.createElement('div');
  document.body.append(root);
  const stop = mount(root, { staff: { role: 'head' }, params: [ID] });
  t.after(stop);
  await tick();
  const side = root.querySelector('.adm2-side');
  assert.match(side.textContent, /Возврат не удался/);
  assert.match(side.textContent, /Нужен ручной возврат в кабинете Click/);
  assert.equal(side.querySelector('[data-act="refund"]'), null);
  side.querySelector('[data-act="retry"]').click();
  await submit();
  const post = posts().at(-1);
  assert.equal(post.url, '/api/admin/refunds/rf-1/retry');
  assert.match(post.headers['Idempotency-Key'], /^[\w-]{8,64}$/);
  assert.match(document.getElementById('toast').textContent, /Новый возврат запущен/);
});
