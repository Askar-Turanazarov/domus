// 12 §5, §12.3: the screen of clients — rows with masks and the mark of «waiting for a manager», filters going to the server, the card with
// «Show» (the full number only after the press), «Take it», bookings / payments / dialogs with the feed, server text kept as text —
// and the Telegram dialog of the staff member (link, wait, linked, unlink).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div><div id="toast" hidden></div></body></html>');
globalThis.document = document;
globalThis.history = { replaceState() {} };
const EVIL = '<img src=x onerror=alert(1)>';
const ID = '22222222-2222-4222-8222-222222222222';
const DLG = '44444444-4444-4444-8444-444444444444';
const iso = ms => new Date(Date.now() + ms).toISOString();

const row = (id, extra = {}) => ({ id, name: EVIL, phone: '+998 90 *** ** 67', phoneVerified: true, telegramUsername: 'dilnoza_r', channels: ['web', 'telegram'], lang: 'ru',
  leadScore: 'hot', lastActiveAt: iso(-60e3), assignee: null, waiting: false, hasActiveBooking: true, ...extra });
const list = { items: [row(ID), row('33333333-3333-4333-8333-333333333333', { name: 'Бобур', leadScore: null, waiting: true, assignee: { id: 's1', name: 'Азиз' }, channels: ['web'] })], next: null };
const cardOf = (extra = {}) => ({
  client: { id: ID, name: EVIL, phone: '+998 90 *** ** 67', hasPhone: true, phoneVerified: true, telegramUsername: 'dilnoza_r', telegramLinked: true, telegramBlocked: false,
    lang: 'ru', channels: ['web', 'telegram'], firstChannel: 'web', createdAt: iso(-86400e3), lastSeenAt: iso(-60e3), assignee: null,
    lead: { score: 'hot', summary: EVIL, nextStep: 'Позвонить', scoredAt: iso(-3600e3) }, possibleDuplicate: false, waiting: false, ...extra },
  bookings: [{ no: 1001, status: 'booked', apartment: { no: 41, rooms: 2, floor: 5 }, deposit: 10e6, heldAt: iso(-3600e3), expiresAt: iso(86400e3) }],
  payments: [{ id: '11111111-1111-4111-8111-111111111111', code: 'P-7F3A', kind: 'deposit', provider: 'card', amount: 10e6, status: 'succeeded', cardBrand: 'HUMO', cardMask: '9860 •••• 0001',
    createdAt: iso(-3600e3), bookingNo: 1001, orderNo: null }],
  viewings: [{ id: 'v1', apartmentNo: 41, at: iso(86400e3), status: 'scheduled', channel: 'web' }],
  orders: [{ no: 501, kind: 'furniture', stage: 'new', estimate: 5e6, apartmentNo: 41, createdAt: iso(-60e3) }],
  dialogs: [{ id: DLG, channel: 'telegram', lang: 'ru', mode: 'human', messageCount: 3, createdAt: iso(-7200e3), lastMessageAt: iso(-60e3) }],
  merges: [{ at: iso(-7200e3), rule: 'R1', fromChannel: 'telegram' }]
});
const feedBody = { conversation: { id: DLG, mode: 'human' }, messages: [
  { id: 1, role: 'user', text: EVIL, blocks: [], createdAt: iso(-3000e3) },
  { id: 2, role: 'assistant', text: 'Три варианта', blocks: [{ type: 'apartments', data: { items: [{ no: 41 }, { no: 42 }] } }], createdAt: iso(-2900e3) },
  { id: 3, role: 'staff', text: 'Здравствуйте', blocks: [], createdAt: iso(-60e3) }] };

const calls = [];
let cardBody = cardOf(), postAnswer = null, meLinked = false;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), method = init.method ?? 'GET';
  calls.push({ url: u, method, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
  const answer = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  if (method === 'POST' && u.endsWith('/reveal-phone')) return postAnswer ?? answer({ phone: '+998901234567' });
  if (method === 'POST' && u.endsWith('/assign')) return postAnswer ?? answer({ client: { ...cardBody.client, assignee: { id: 's1', name: 'Азиз' } }, taken: true });
  if (method === 'POST' && u === '/api/admin/me/telegram-link') return postAnswer ?? answer({ url: 'https://t.me/ChinorParkBot?start=st_abc123', expiresAt: iso(900e3) });
  if (method === 'DELETE' && u === '/api/admin/me/telegram') { meLinked = false; return { ok: true, status: 204, json: async () => null }; }
  if (u === '/api/admin/me') return answer({ staff: { id: 's1', name: 'Азиз', role: 'manager', lang: 'ru', telegramLinked: meLinked } });
  if (u.startsWith('/api/admin/clients?')) return answer({ ...list, at: new Date().toISOString() });
  if (u.startsWith('/api/admin/clients/')) return answer({ ...cardBody, at: new Date().toISOString() });
  if (u.startsWith('/api/admin/conversations/')) return answer({ ...feedBody, at: new Date().toISOString() });
  throw new Error('unexpected ' + method + ' ' + u);
};

const { mount } = await import('../../public/admin/views/clients.js');
const { openTelegramDialog } = await import('../../public/admin/telegram.js');
const tick = (ms = 25) => new Promise(r => setTimeout(r, ms));

async function open(t, params = []) {
  cardBody = cardOf(); postAnswer = null;
  const root = document.createElement('div');
  document.body.append(root);
  const stop = mount(root, { staff: { role: 'manager' }, params });
  t.after(stop);
  await tick();
  return root;
}

test('the list: a row per client, masks, the mark of waiting, names as text', async t => {
  const root = await open(t);
  const rows = [...root.querySelectorAll('tbody tr')];
  assert.equal(rows.length, 2);
  assert.ok(rows[0].textContent.includes(EVIL));
  assert.match(rows[0].textContent, /\+998 90 \*\*\* \*\* 67/);
  assert.match(rows[0].textContent, /@dilnoza_r/);
  assert.match(rows[0].textContent, /Горячий/);
  assert.match(rows[1].textContent, /Бобур/);
  assert.match(rows[1].textContent, /ждёт менеджера/);
  assert.match(rows[1].textContent, /Азиз/);
  assert.match(rows[1].textContent, /Не оценён/);
  assert.equal(root.querySelector('img'), null);
});

test('filters go to the server: score, flags, search with a pause', async t => {
  const root = await open(t);
  const sel = root.querySelector('select[name="score"]');
  sel.querySelector('option[value="hot"]').selected = true;
  sel.dispatchEvent(new window.Event('change'));
  await tick();
  assert.match(calls.at(-1).url, /score=hot/);
  root.querySelector('[data-flag="waiting"]').click();
  await tick();
  assert.match(calls.at(-1).url, /score=hot/);
  assert.match(calls.at(-1).url, /waiting=1/);
  assert.equal(root.querySelector('[data-flag="waiting"]').getAttribute('aria-pressed'), 'true');
  const q = root.querySelector('input[name="q"]');
  q.value = '@dilnoza';
  q.dispatchEvent(new window.Event('input'));
  await tick(400);
  assert.match(calls.at(-1).url, /q=%40dilnoza/);
});

test('the card: contacts as a mask, «Show» asks the server and shows the number, the rest of the blocks', async t => {
  const root = await open(t);
  root.querySelector('tbody tr').click();
  await tick();
  const side = root.querySelector('.adm2-side');
  assert.match(side.textContent, /\+998 90 \*\*\* \*\* 67/);
  assert.ok(!side.textContent.includes('1234567'));
  assert.match(side.textContent, /Позвонить/);
  assert.match(side.textContent, /Бронь №1001/);
  assert.match(side.textContent, /кв\. №41/);
  assert.ok(side.querySelector('a[href="#/bookings/1001"]') && side.querySelector('a[href="#/payments/11111111-1111-4111-8111-111111111111"]'));
  assert.match(side.textContent, /Заказ №501/);
  assert.match(side.textContent, /запланирован/);
  assert.match(side.textContent, /правило R1/);
  assert.equal(side.querySelector('img'), null);
  assert.ok(!/\d{4} \d{4} \d{4} \d{4}/.test(side.textContent), 'no card number');

  const before = calls.filter(c => c.method === 'POST').length;
  side.querySelector('[data-act="reveal"]').click();
  await tick();
  const post = calls.filter(c => c.method === 'POST').at(-1);
  assert.equal(calls.filter(c => c.method === 'POST').length, before + 1);
  assert.equal(post.url, `/api/admin/clients/${ID}/reveal-phone`);
  assert.equal(post.headers['X-Requested-With'], 'domus-admin');
  assert.match(root.querySelector('.adm2-side [data-phone]').textContent, /\+998901234567/);
  assert.equal(root.querySelector('[data-act="reveal"]'), null, 'the button is gone once the number is shown');
});

test('«Take it»: the request, the success toast; if someone was faster the person is told who', async t => {
  const root = await open(t);
  root.querySelector('tbody tr').click();
  await tick();
  root.querySelector('[data-act="take"]').click();
  await tick();
  let post = calls.filter(c => c.method === 'POST').at(-1);
  assert.equal(post.url, `/api/admin/clients/${ID}/assign`);
  assert.deepEqual(post.body, { staffId: 'me' });
  assert.match(document.getElementById('toast').textContent, /Клиент ваш/);

  postAnswer = { ok: true, status: 200, json: async () => ({ client: { ...cardBody.client, assignee: { id: 's2', name: 'Мадина' } }, taken: false }) };
  root.querySelector('[data-act="take"]').click();
  await tick();
  assert.match(document.getElementById('toast').textContent, /Клиента уже взял Мадина/);
});

test('a dialog opens into the feed with roles and the blocks, as text; closing hides it', async t => {
  const root = await open(t, [ID]);
  const side = root.querySelector('.adm2-side');
  assert.match(side.textContent, /ждёт менеджера/);
  side.querySelector(`[data-dialog="${DLG}"]`).click();
  await tick();
  const items = [...root.querySelectorAll('.adm2-feed li')];
  assert.deepEqual(items.map(li => li.dataset.role), ['user', 'assistant', 'staff']);
  assert.ok(items[0].textContent.includes(EVIL));
  assert.match(items[1].textContent, /Карточки квартир: №41, №42/);
  assert.match(items[2].textContent, /Менеджер/);
  assert.equal(root.querySelector('.adm2-feed img'), null);
  assert.match(calls.at(-1).url, new RegExp(`/api/admin/conversations/${DLG}`));
  root.querySelector(`[data-dialog="${DLG}"]`).click();
  await tick();
  assert.equal(root.querySelector('.adm2-feed'), null);
});

test('the Telegram dialog: ask for a link, show it, wait, see «linked», unlink', async t => {
  meLinked = false;
  let changed = null;
  const close = openTelegramDialog({ staff: { telegramLinked: false }, onChange: me => { changed = me; } });
  t.after(close);
  const modal = () => document.querySelector('.adm2-modal');
  assert.ok(modal().querySelector('[data-act="link"]'));
  modal().querySelector('[data-act="link"]').click();
  await tick();
  const post = calls.filter(c => c.method === 'POST').at(-1);
  assert.equal(post.url, '/api/admin/me/telegram-link');
  assert.equal(post.headers['X-Requested-With'], 'domus-admin');
  const a = modal().querySelector('[data-act="open"]');
  assert.equal(a.getAttribute('href'), 'https://t.me/ChinorParkBot?start=st_abc123');
  assert.match(a.getAttribute('rel'), /noopener/);
  assert.match(modal().textContent, /15 минут/);

  meLinked = true;                                     // the bot has answered; the page notices on the next poll (3 s)
  await tick(3200);
  assert.ok(modal().querySelector('[data-state="linked"]'));
  assert.equal(changed?.telegramLinked, true);

  modal().querySelector('[data-act="unlink"]').click();
  await tick();
  assert.equal(calls.filter(c => c.method === 'DELETE').at(-1).url, '/api/admin/me/telegram');
  assert.ok(modal().querySelector('[data-act="link"]'));
  assert.equal(changed?.telegramLinked, false);
  close();
  assert.equal(modal(), null);
});

test('the Telegram dialog: «not connected» from the server stays in the dialog', async t => {
  postAnswer = { ok: false, status: 503, json: async () => ({ error: 'feature_disabled', message: 'off', vars: {} }) };
  const close = openTelegramDialog({ staff: { telegramLinked: false } });
  t.after(() => { postAnswer = null; close(); });
  document.querySelector('.adm2-modal [data-act="link"]').click();
  await tick();
  assert.match(document.querySelector('.adm2-modal .adm2-err').textContent, /не подключён/);
  assert.equal(document.querySelector('.adm2-modal [data-act="open"]'), null);
});
