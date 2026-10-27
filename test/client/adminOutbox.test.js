// 12 §6–7: the Outbox screen — rows with colour badges, filters going to the server, the card with the message as a bubble (a safe subset of
// the bot's HTML, built by hand, server text never as markup), buttons under it, «send again» — and the demo shift block.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div><div id="toast" hidden></div></body></html>');
globalThis.document = document;
globalThis.history = { replaceState() {} };
const iso = ms => new Date(Date.now() + ms).toISOString();

const item = (id, extra = {}) => ({ id, createdAt: iso(-id * 1000), recipient: { kind: 'client', id: 'c1', name: 'Дилноза' }, template: 'booking_confirmed', op: 'send',
  status: 'sent', skipReason: null, attempts: 1, sentAt: iso(-id * 1000), canResend: false, ...extra });
const items = [item(3, { status: 'failed', canResend: true, attempts: 3 }), item(2, { recipient: { kind: 'staff_group', name: null }, template: 'staff_booking_paid' }),
  item(1, { status: 'skipped', skipReason: 'no_telegram' })];
const cardOf = (extra = {}) => ({ ...items[0], lang: 'ru', nextAttemptAt: null, lastError: 'HTTP 500 boom', attachment: 'booking_pdf',
  preview: { html: '<b>Бронь №1042</b>\n&lt;script&gt; <i>x</i> <a href="https://domus.test/b/1042-••••">открыть</a> <a href="javascript:alert(1)">bad</a> <img src=x onerror=alert(1)>',
    buttons: [{ text: 'Открыть бронь', kind: 'web_app', target: 'https://domus.test/b/1042-••••' }, { text: 'Продлить', kind: 'action', target: null }] },
  event: { type: 'booking.paid', at: iso(-5000) }, bookingNo: 1042, ...extra });

const calls = [];
let postAnswer = null, cardBody = cardOf();
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), method = init.method ?? 'GET';
  calls.push({ url: u, method, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
  const answer = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  if (method === 'POST' && u.endsWith('/resend')) return postAnswer ?? answer({ status: 'retry' });
  if (method === 'POST' && u.endsWith('/shift')) return postAnswer ?? answer({ booking: { no: 1042, version: 3 } });
  if (u.startsWith('/api/admin/outbox?')) return answer({ items, next: null });
  if (u.startsWith('/api/admin/outbox/')) return answer(cardBody);
  throw new Error('unexpected ' + method + ' ' + u);
};

const { mount, bubbleNodes } = await import('../../public/admin/views/outbox.js');
const { shiftBlock } = await import('../../public/admin/views/shift.js');
const tick = (ms = 25) => new Promise(r => setTimeout(r, ms));
const submit = async () => { document.querySelector('.adm2-modal form').dispatchEvent(new window.Event('submit', { cancelable: true })); await tick(); };

async function open(t, params = [], card = cardOf()) {
  cardBody = card; postAnswer = null; calls.length = 0;
  document.querySelectorAll('.adm2-modal').forEach(m => m.remove());
  const root = document.createElement('div');
  document.body.append(root);
  const stop = mount(root, { staff: { role: 'head' }, params });
  t.after(stop);
  await tick();
  return root;
}

test('the list: a row per message, coloured status, the last 200 asked of the server', async t => {
  const root = await open(t);
  const rows = [...root.querySelectorAll('tbody tr')];
  assert.equal(rows.length, 3);
  assert.match(rows[0].textContent, /Не доставлено/);
  assert.ok(rows[0].querySelector('.ob-failed'));
  assert.match(rows[1].textContent, /Группа менеджеров/);
  assert.match(rows[2].textContent, /нет Telegram/);
  assert.match(calls[0].url, /limit=200/);
});

test('filters go to the server', async t => {
  const root = await open(t);
  const sel = root.querySelector('select[name="status"]');
  [...sel.options].find(o => o.value === 'failed').selected = true;
  sel.dispatchEvent(new window.Event('change'));
  await tick();
  assert.ok(calls.some(c => /status=failed/.test(c.url)));
});

test('the card: the bubble keeps the safe tags, drops the rest as text, buttons under it, «send again» only when allowed', async t => {
  const root = await open(t, ['3']);
  const bubble = root.querySelector('[data-part="bubble"]');
  assert.ok(bubble.querySelector('b'));
  assert.equal(bubble.querySelector('b').textContent, 'Бронь №1042');
  assert.ok(bubble.textContent.includes('<script>'));                       // an escaped tag shows as text
  assert.ok(bubble.textContent.includes('<img src=x onerror=alert(1)>'));   // a foreign tag stays text
  assert.equal(bubble.querySelector('img'), null);
  const links = [...bubble.querySelectorAll('a')];
  assert.equal(links[0].getAttribute('href'), 'https://domus.test/b/1042-••••');
  assert.equal(links[1].getAttribute('href'), null);                        // javascript: is dropped
  assert.deepEqual([...root.querySelectorAll('.adm2-tgbtn')].map(b => b.textContent), ['Открыть бронь', 'Продлить']);
  assert.match(root.querySelector('.adm2-side').textContent, /HTTP 500 boom/);
  assert.match(root.querySelector('.adm2-side').textContent, /booking_pdf/);

  root.querySelector('[data-act="resend"]').click();
  await tick();
  const post = calls.find(c => c.method === 'POST');
  assert.match(post.url, /\/api\/admin\/outbox\/3\/resend$/);
  assert.match(document.getElementById('toast').textContent, /Поставлено в очередь/);
});

test('no resend button for a sent message', async t => {
  const root = await open(t, ['2'], cardOf({ id: 2, status: 'sent', canResend: false }));
  assert.ok(root.querySelector('[data-part="bubble"]'));
  assert.equal(root.querySelector('[data-act="resend"]'), null);
});

test('bubbleNodes never builds a tag outside the whitelist', () => {
  const box = bubbleNodes('<b>a</b><script>alert(1)</script><a href="https://x.y/z">l</a>');
  assert.equal(box.querySelector('script'), null);
  assert.ok(box.textContent.includes('<script>alert(1)</script>'));
  assert.equal(box.querySelector('a').getAttribute('href'), 'https://x.y/z');
});

test('shift block: one button for a hold, three for a booking, none for a closed one; the confirmation names the time; the POST carries the version', async () => {
  assert.equal(shiftBlock({ no: 1042, status: 'expired', version: 1 }, () => {}), null);
  assert.equal(shiftBlock({ no: 1042, status: 'held', version: 1 }, () => {}).querySelectorAll('button').length, 1);
  let done = 0;
  const block = shiftBlock({ no: 1042, status: 'booked', version: 7 }, () => { done++; });
  document.body.append(block);
  assert.deepEqual([...block.querySelectorAll('button')].map(b => b.dataset.target), ['booking_1m', 'booking_3h1m', 'booking_24h1m']);
  calls.length = 0;
  block.querySelector('[data-target="booking_3h1m"]').click();
  assert.match(document.querySelector('.adm2-modal').textContent, /Это демо-действие: срок брони №1042 станет \d/);
  await submit();
  const post = calls.find(c => c.method === 'POST');
  assert.match(post.url, /\/api\/admin\/bookings\/1042\/shift$/);
  assert.deepEqual(post.body, { target: 'booking_3h1m', expectedVersion: 7 });
  assert.ok(post.headers['Idempotency-Key']);
  assert.equal(done, 1);
  block.remove();
});

test('shift block: a stale answer refreshes the screen and keeps no error', async () => {
  let done = 0;
  postAnswer = { ok: false, status: 409, json: async () => ({ error: 'stale', vars: {} }) };
  const block = shiftBlock({ no: 1042, status: 'held', version: 1 }, () => { done++; });
  document.body.append(block);
  block.querySelector('button').click();
  await submit();
  assert.equal(done, 1);
  assert.match(document.getElementById('toast').textContent, /Бронь изменилась/);
  postAnswer = null;
  block.remove();
});
