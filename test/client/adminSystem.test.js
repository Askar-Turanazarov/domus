// 12 §10: the «Система» screen — a form per key with the value it was opened with, a save carrying expectedUpdatedAt, a stale answer replacing the
// value, view-only keys without a button, the services, the demo switches with «who answers now», the reset of a provider; server text stays text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div><div id="toast" hidden></div></body></html>');
globalThis.document = document;
globalThis.history = { replaceState() {} };
const EVIL = '<img src=x onerror=alert(1)>';
const iso = ms => new Date(Date.now() + ms).toISOString();

const item = (key, value, extra = {}) => ({ key, value, updatedAt: '2026-10-28T05:00:00.000Z', updatedBy: null, editable: true, ...extra });
let settings;
const fresh = () => {
  settings = [item('deposit_amount', 10_000_000), item('hold_minutes', 15), item('booking_hours', 72), item('max_active_bookings', 2),
    item('installment', { minDownPct: 30, terms: [{ months: 12, markupPct: 0 }, { months: 24, markupPct: 5 }] }, { updatedBy: 'Азиз' }),
    item('furniture_prepay_pct', 30), item('reminders', { bookingHoursBefore: [24, 3], viewingHoursBefore: 3 }), item('extend_max_hours', 168),
    item('chat_limits', { perMinute: 10, perDay: 200, perConversation: 40 }), item('offer_version', '2026-10-27', { editable: false }),
    item('ai', { geminiDisabled: false, primaryDisabled: false, geminiTier: 'free' }),
    item('bank_requisites', { name: EVIL, inn: '000000000' }, { editable: false })];
};
const system = (extra = {}) => ({ services: { db: 'ok', qstash: 'ok', telegram: 'not_configured', stripe: 'test', click: 'emulator', version: 'abc1234',
  telegramWebhook: { lastAt: null, lastError: EVIL, stuck: 2 }, jobs: { scheduled: 4, late: 1 }, outbox: { failed: 1, waiting: 3 }, keys: { gemini: true, anthropic: false } },
ai: { providers: { gemini: { key: true, status: 'ok', demoDisabled: false, models: {
  'gemini-3.8-flash': { status: 'cooldown', until: iso(3600e3), reason: 'rate_day', today: 1500, limit: 1500 }, 'gemini-3.6-flash': { status: 'ok', today: 214, limit: 1500 } } },
anthropic: { key: false, status: 'ok', models: { 'claude-sonnet-5-5': { status: 'ok' } } } },
answering: { tools: { model: 'gemini-3.6-flash', mode: 'reserve' }, fast: { model: 'gemini-3.5-flash-lite', mode: 'primary' } },
embeddings: 'ok', switches: {}, reserveKey: false, spentTodayUsd: 0.41, budgetUsd: 5, ...extra } });

const calls = [];
let putAnswer = null, systemBody = system();
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), method = init.method ?? 'GET';
  calls.push({ url: u, method, body: init.body ? JSON.parse(init.body) : undefined });
  const answer = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  if (method === 'PUT') {
    if (putAnswer) return putAnswer;
    const key = u.split('/').pop(), value = JSON.parse(init.body).value;
    const row = { ...settings.find(i => i.key === key), value, updatedAt: '2026-10-28T06:00:00.000Z', updatedBy: 'Руководитель' };
    settings = settings.map(i => (i.key === key ? row : i));
    return answer({ item: row });
  }
  if (method === 'POST' && u.endsWith('/reset')) return answer({ state: { status: 'ok' } });
  if (u === '/api/admin/settings') return answer({ items: settings });
  if (u === '/api/admin/system') return answer(systemBody);
  throw new Error('unexpected ' + method + ' ' + u);
};

const { mount } = await import('../../public/admin/views/system.js');
const tick = (ms = 25) => new Promise(r => setTimeout(r, ms));

async function open(t, params = []) {
  fresh(); putAnswer = null; systemBody = system(); calls.length = 0;
  document.getElementById('toast').textContent = '';
  const root = document.createElement('div');
  document.body.append(root);
  const stop = mount(root, { staff: { role: 'head' }, params });
  t.after(stop);
  await tick();
  return root;
}
const block = (root, key) => root.querySelector(`[data-setting="${key}"]`);
const change = (input, value) => { input.value = String(value); input.dispatchEvent(new window.Event('input')); };

test('settings: a block per key with the value, the editor line, no button on view-only keys, the bank table as text', async t => {
  const root = await open(t);
  assert.equal(root.querySelectorAll('[data-setting]').length, 11);          // `ai` lives on the other tab
  assert.equal(block(root, 'hold_minutes').querySelector('input').value, '15');
  assert.match(block(root, 'installment').textContent, /Азиз/);
  assert.match(block(root, 'hold_minutes').textContent, /по умолчанию/);
  assert.equal(block(root, 'offer_version').querySelector('button'), null);
  assert.ok(block(root, 'bank_requisites').textContent.includes(EVIL));
  assert.equal(block(root, 'bank_requisites').querySelector('img'), null);
  assert.match(root.textContent, /новые удержания и брони/);
});

test('a save sends the value and expectedUpdatedAt of the opened form and shows who changed it', async t => {
  const root = await open(t);
  change(block(root, 'hold_minutes').querySelector('input'), 20);
  block(root, 'hold_minutes').querySelector('[data-act="save"]').click();
  await tick();
  const put = calls.find(c => c.method === 'PUT');
  assert.match(put.url, /\/api\/admin\/settings\/hold_minutes$/);
  assert.deepEqual(put.body, { value: 20, expectedUpdatedAt: '2026-10-28T05:00:00.000Z' });
  assert.match(document.getElementById('toast').textContent, /Сохранено/);
  assert.match(block(root, 'hold_minutes').textContent, /Руководитель/);
});

test('the installment table: rows are read, added and removed; reminders and limits are read as numbers', async t => {
  const root = await open(t);
  const inst = block(root, 'installment');
  inst.querySelector('[data-term] button').click();                             // remove the first term
  inst.querySelector('[data-act="add-term"]').click();
  const rows = [...inst.querySelectorAll('[data-term]')];
  assert.equal(rows.length, 2);
  change(rows[1].querySelectorAll('input')[0], 36);
  change(rows[1].querySelectorAll('input')[1], 10);
  inst.querySelector('[data-act="save"]').click();
  await tick();
  assert.deepEqual(calls.find(c => c.method === 'PUT').body.value, { minDownPct: 30, terms: [{ months: 24, markupPct: 5 }, { months: 36, markupPct: 10 }] });

  calls.length = 0;
  const rem = block(root, 'reminders');
  change(rem.querySelector('input[type="text"]'), '48, 12 ,1');
  rem.querySelector('[data-act="save"]').click();
  await tick();
  assert.deepEqual(calls.find(c => c.method === 'PUT').body.value, { bookingHoursBefore: [48, 12, 1], viewingHoursBefore: 3 });
});

test('stale: the current value replaces the form and the toast says so', async t => {
  const root = await open(t);
  putAnswer = { ok: false, status: 409, json: async () => ({ error: 'stale', message: 'x', vars: { current: item('hold_minutes', 25, { updatedBy: 'Другой' }) } }) };
  change(block(root, 'hold_minutes').querySelector('input'), 20);
  block(root, 'hold_minutes').querySelector('[data-act="save"]').click();
  await tick();
  assert.match(document.getElementById('toast').textContent, /уже изменили/);
  assert.equal(block(root, 'hold_minutes').querySelector('input').value, '25');
  assert.match(block(root, 'hold_minutes').textContent, /Другой/);
});

test('a refused value shows the server message and keeps the form', async t => {
  const root = await open(t);
  putAnswer = { ok: false, status: 400, json: async () => ({ error: 'invalid_input', message: 'Проверьте: value', vars: {} }) };
  change(block(root, 'hold_minutes').querySelector('input'), 4);
  block(root, 'hold_minutes').querySelector('[data-act="save"]').click();
  await tick();
  assert.match(document.getElementById('toast').textContent, /Проверьте/);
  assert.equal(block(root, 'hold_minutes').querySelector('input').value, '4');
});

test('services: statuses, webhook error as text, keys without values, who answers now, the counters, reset only where it helps', async t => {
  const root = await open(t, ['services']);
  const s = root.querySelector('[data-part="services"]');
  assert.match(s.textContent, /Не настроено/);
  assert.ok(s.textContent.includes(EVIL));
  assert.equal(s.querySelector('img'), null);
  assert.match(s.textContent, /Зависших обновлений: 2/);
  assert.match(s.textContent, /опоздали: 1/);
  assert.match(s.textContent, /Gemini: есть; Claude: нет/);
  const ai = root.querySelector('[data-part="ai"]');
  assert.match(ai.textContent, /gemini-3\.6-flash \(резерв\)/);
  assert.match(ai.textContent, /gemini-3\.5-flash-lite \(основная\)/);
  assert.match(ai.textContent, /\$0\.41 из \$5\.00/);
  assert.equal(root.querySelector('tr[data-key="gemini:gemini-3.8-flash"] td:nth-child(5)').textContent, '1500 / 1500');
  assert.ok(root.querySelector('[data-act="reset"][data-key="gemini:gemini-3.8-flash"]'));
  assert.equal(root.querySelector('[data-act="reset"][data-key="gemini:gemini-3.6-flash"]'), null);
});

test('the reset posts to the provider key and reloads', async t => {
  const root = await open(t, ['services']);
  calls.length = 0;
  root.querySelector('[data-act="reset"][data-key="gemini:gemini-3.8-flash"]').click();
  await tick();
  assert.ok(calls.some(c => c.method === 'POST' && c.url === '/api/admin/ai/providers/gemini%3Agemini-3.8-flash/reset'));
  assert.ok(calls.some(c => c.url === '/api/admin/system'));
  assert.match(document.getElementById('toast').textContent, /Состояние сброшено/);
});

test('the demo switch saves the whole «ai» value with the opened time and shows the hint when there is no reserve key', async t => {
  const root = await open(t, ['services']);
  assert.equal(root.querySelector('[data-part="no-reserve"]'), null);
  calls.length = 0;
  systemBody = system({ providers: { ...system().ai.providers, gemini: { ...system().ai.providers.gemini, demoDisabled: true } } });
  const box = root.querySelector('input[name="geminiDisabled"]');
  box.checked = true;
  box.dispatchEvent(new window.Event('change'));
  await tick(60);
  const put = calls.find(c => c.method === 'PUT');
  assert.match(put.url, /settings\/ai$/);
  assert.deepEqual(put.body, { value: { geminiDisabled: true, primaryDisabled: false, geminiTier: 'free' }, expectedUpdatedAt: '2026-10-28T05:00:00.000Z' });
  assert.match(root.querySelector('[data-part="gemini-off"]').textContent, /отключён вручную/);
  assert.match(root.querySelector('[data-part="no-reserve"]').textContent, /Резерва нет/);
  assert.equal(root.querySelector('input[name="geminiDisabled"]').checked, true);
});

test('the Gemini tier is saved from the select', async t => {
  const root = await open(t, ['services']);
  calls.length = 0;
  const sel = root.querySelector('select[name="geminiTier"]');
  [...sel.options].find(o => o.value === 'paid').selected = true;
  sel.dispatchEvent(new window.Event('change'));
  await tick(60);
  assert.equal(calls.find(c => c.method === 'PUT').body.value.geminiTier, 'paid');
});
