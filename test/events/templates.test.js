// Templates and delivery (04 §4, §3.2): three languages for every template, all variables placed, the recipient's language,
// escaping, buttons; and the whole way — a hold in the bot → a row → one Telegram call → sent.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GrammyError, HttpError } from 'grammy';
import { fakeClock } from '../../server/core/clock.js';
import { createHold } from '../../server/core/bookings.js';
import { deliver } from '../../server/core/outbox.js';
import { afterCommit } from '../../server/events/runner.js';
import { render, createRender } from '../../server/notify/render.js';
import { TEMPLATES, templateIds } from '../../server/notify/templates.js';
import { createSender } from '../../server/notify/telegramSender.js';
import { t } from '../../server/i18n/index.js';
import { createTestDb, resetDb } from '../support/db.js';
import { makeClient } from '../support/factories.js';

let db;
const LANGS = ['ru', 'uz', 'en'];
const ENV = { TELEGRAM_STAFF_CHAT_ID: '-1', LINK_SECRET: 'test-secret', PUBLIC_URL: 'https://domus.test' };
const OPTS = { publicUrl: 'https://domus.test' };
const WEB = { type: 'client', id: null, role: 'client', channel: 'web' };
before(async () => { db = await createTestDb(); });
after(() => db.close());
beforeEach(async () => { await resetDb(db); fakeClock.set('2026-10-28T10:00:00+05:00'); });
afterEach(() => fakeClock.reset());

// A value for every variable of a template, as the core would put it.
const SAMPLE = {
  apt: 41, min: 15, deposit: 10_000_000, holdUntil: '2026-10-28T05:15:00.000Z', until: '2026-10-30T05:00:00.000Z', at: '2026-10-29T13:00:00.000Z',
  link: '/b/1042-abcdefghijklmnopqrstuvwxyz012345', reason: 'bank_declined', hours: 3, bookingNo: 1042, initiator: 'developer', amount: 10_000_000,
  address: 'Chinor Park, 1', mapUrl: 'https://maps.example/chinor', time: '18:00', rooms: 2, area: 82.4, price: 612_000_000, name: 'Аня',
  phoneMasked: '+998 90 *** ** 67', channel: 'telegram', provider: 'card', context: 'ищет 2-комн.', clientId: '3f0c2a52-8c0e-4b52-9a3e-1d6a6f2c9a10',
  staffName: 'Азиз', fate: 'refund', comment: 'позвоните после 18', hoursText: ' (осталось 20 ч)'
};
const sampleOf = id => Object.fromEntries(TEMPLATES[id].vars.map(v => [v, SAMPLE[v]]));
// `reason` is a code in payment_failed / staff_refund_done and a free text elsewhere.
const varsOf = id => {
  const v = sampleOf(id);
  if (id === 'staff_refund_done') v.reason = 'developer_cancel';
  else if (v.reason && id !== 'payment_failed') v.reason = 'передумал';
  if (id === 'staff_lead_taken') return { of: 'staff_booking_paid', ...sampleOf('staff_booking_paid'), staffName: 'Тимур' };
  return v;
};
const PLACEHOLDER = /\{\w+\}/;
const plain = s => s.replace(/ /g, ' ');             // sums use non-breaking spaces; the expected texts are written with plain ones

test('every template has a text in ru, uz and en; every button has a caption; the variants too', () => {
  for (const id of templateIds) {
    if (TEMPLATES[id].composed) continue;
    for (const lang of LANGS) {
      const variants = [null, ...['client', 'developer', 'nobooking'].filter(v => t(lang, `tpl.${id}.text.${v}`))];
      assert.ok(variants.length >= 1);
      if (!t(lang, `tpl.${id}.text`)) assert.ok(variants.length > 1, `${id} has no text in ${lang}`);
      for (const b of TEMPLATES[id].buttons) assert.ok(t(lang, `tpl.btn.${b.key}`), `${id}: button ${b.key} in ${lang}`);
    }
  }
  const unlisted = ['booking_cancelled', 'refund_done', 'staff_refund_done'];
  for (const id of unlisted) for (const lang of LANGS) {
    const keys = id === 'booking_cancelled' ? ['text.client', 'text.developer'] : ['text', 'text.nobooking'];
    for (const k of keys) assert.ok(t(lang, `tpl.${id}.${k}`), `${id}.${k} in ${lang}`);
  }
});

test('every template renders in three languages with every variable in place and no leftover «{…}»', () => {
  for (const id of templateIds) for (const lang of LANGS) {
    const m = render(id, lang, varsOf(id), OPTS);
    assert.ok(m?.text, `${id} ${lang}`);
    assert.doesNotMatch(m.text, PLACEHOLDER, `${id} ${lang}: ${m.text}`);
    assert.equal(m.parse_mode, 'HTML');
  }
});

test('the variants: reason or no reason, a refund with or without a booking, both initiators', () => {
  const dev = plain(render('booking_cancelled', 'ru', { apt: 41, reason: 'ошибка', initiator: 'developer', deposit: 10_000_000 }, OPTS).text);
  assert.equal(dev, 'Бронь квартиры №41 отменена застройщиком: ошибка. Депозит 10 000 000 сум будет возвращён полностью.');
  const own = render('booking_cancelled', 'en', { apt: 41, reason: '', initiator: 'client', deposit: 1 }, OPTS).text;
  assert.equal(own, 'Your booking of apartment 41 is cancelled: no reason given. Under the offer terms the deposit is not returned.');
  assert.equal(plain(render('refund_done', 'ru', { amount: 10_000_000, bookingNo: null }, OPTS).text), 'Возврат 10 000 000 сум выполнен.');
  assert.equal(plain(render('refund_done', 'ru', { amount: 10_000_000, bookingNo: 1042 }, OPTS).text), 'Возврат 10 000 000 сум по брони №1042 выполнен.');
  assert.equal(render('payment_failed', 'ru', { reason: 'insufficient_funds', apt: 41, holdUntil: '2026-10-28T05:15:00Z' }, OPTS).text,
    'Оплата не прошла: Недостаточно средств на карте. Квартира №41 ещё закреплена за вами до 28.10, 10:15 — можно попробовать снова.');
  assert.match(render('staff_booking_expiring', 'ru', { bookingNo: 1, apt: 2, until: '2026-10-30T05:00:00Z', staffName: '' }, OPTS).text, /Ответственный: не назначен\./);
});

test('the sample message, word for word: Tashkent time, spaced sums, masked phone', () => {
  const m = render('booking_confirmed', 'ru', { apt: 41, until: '2026-10-30T05:00:00.000Z', bookingNo: 1042, deposit: 10_000_000, link: '/b/1042-x' }, OPTS);
  assert.equal(plain(m.text), '✅ Квартира №41 забронирована до 30.10, 10:00. Бронь №1042, депозит 10 000 000 сум (засчитывается в стоимость и в первый взнос). Менеджер свяжется с вами. Ваша страница брони — по кнопке.');
  assert.ok(render('booking_confirmed', 'en', { apt: 41, until: '2026-10-30T05:00:00.000Z', bookingNo: 1042, deposit: 10_000_000 }, OPTS).text
    .startsWith('✅ Apartment 41 is booked until Oct 30, 10:00 AM. Booking 1042, '));
  const staff = plain(render('staff_booking_paid', 'ru', varsOf('staff_booking_paid'), OPTS).text);
  assert.match(staff, /Клиент: Аня, \+998 90 \*\*\* \*\* 67, Telegram\. Депозит 10 000 000 сум через карту \(HUMO\/Uzcard\)\. До 30\.10, 10:00\. Контекст: ищет 2-комн\.$/);
});

test('names and free text cannot break Telegram HTML', () => {
  const m = render('staff_new_request', 'ru', { apt: 41, name: '<b>Аня</b> & Ко', phoneMasked: '+998', comment: '<script>x</script>', clientId: 'c1' }, OPTS);
  assert.ok(m.text.includes('&lt;b&gt;Аня&lt;/b&gt; &amp; Ко'));
  assert.ok(!m.text.includes('<script>'));
});

test('buttons: a mini-app button for the client, links in the group, take: ≤ 64 bytes; no https — no link buttons', () => {
  const pay = render('hold_created', 'ru', varsOf('hold_created'), OPTS);
  assert.deepEqual(pay.reply_markup.inline_keyboard, [[{ text: '💳 Оплатить', web_app: { url: `https://domus.test${SAMPLE.link}` } }]]);
  const own = render('booking_confirmed', 'uz', varsOf('booking_confirmed'), OPTS).reply_markup.inline_keyboard.flat();
  assert.deepEqual(own.map(b => b.web_app.url), [`https://domus.test${SAMPLE.link}`, 'https://domus.test/uz#apt=41']);

  const group = render('staff_booking_paid', 'ru', varsOf('staff_booking_paid'), OPTS).reply_markup.inline_keyboard.flat();
  assert.deepEqual(group, [
    { text: '🙋 Беру клиента', callback_data: `take:${SAMPLE.clientId}` },
    { text: '🔗 Открыть в админке', url: `https://domus.test/admin/clients/${SAMPLE.clientId}` }]);
  assert.ok(Buffer.byteLength(group[0].callback_data) <= 64);
  assert.equal(group[0].callback_data.length, 41);

  const plain = render('hold_created', 'ru', varsOf('hold_created'), { publicUrl: 'http://localhost:3000' });
  assert.equal(plain.reply_markup, undefined, 'web_app and url buttons need https');
  const noTake = render('staff_new_request', 'ru', { apt: 1, name: 'x', phoneMasked: '', comment: '' }, OPTS).reply_markup.inline_keyboard.flat();
  assert.deepEqual(noTake.map(b => b.text), ['🔗 Открыть в админке'], 'no client id — no «Беру»');
});

test('staff_lead_taken: the same text, a line «Взял …», «Беру» gone, «Открыть в админке» stays', () => {
  const orig = render('staff_booking_paid', 'ru', sampleOf('staff_booking_paid'), OPTS);
  const taken = render('staff_lead_taken', 'ru', varsOf('staff_lead_taken'), OPTS);
  assert.equal(taken.text, `${orig.text}\n\n✅ Взял Тимур`);
  assert.deepEqual(taken.reply_markup.inline_keyboard.flat().map(b => b.text), ['🔗 Открыть в админке']);
  assert.equal(render('staff_lead_taken', 'ru', { of: 'nonsense', staffName: 'x' }, OPTS), null);
});

test('render never throws: an unknown template is null, a missing variable an empty place', () => {
  assert.equal(render('nonsense', 'ru', {}, OPTS), null);
  assert.equal(render('hold_expired', 'ru', {}, OPTS).text, 'Время на оплату вышло. Квартира № снова доступна для бронирования.');
  assert.equal(createRender({})('hold_expired', 'zz', null).text.startsWith('Время'), true, 'an unknown language falls back to ru');
});

// ── the way to the client

const fakeApi = (fail = null) => {
  const calls = [];
  return { calls, api: {
    sendMessage: async (chat, text, other) => { calls.push({ method: 'sendMessage', chat, text, other }); if (fail) throw fail; return { message_id: 900 + calls.length }; },
    editMessageText: async (chat, id, text, other) => { calls.push({ method: 'editMessageText', chat, id, text, other }); if (fail) throw fail; return true; }
  } };
};
const grammyError = (code, description, parameters = {}) => new GrammyError('call failed', { ok: false, error_code: code, description, parameters }, 'sendMessage', {});

async function holdInBot({ send, lang = 'uz' } = {}) {
  const render = createRender(ENV);
  const done = [];
  const opts = { env: ENV, render, onCommit: fx => done.push(afterCommit(db, fx, { env: ENV, send })) };
  const r = await createHold(db, { apartmentNo: 41, client: { telegram: { userId: 77, chatId: 77 }, lang }, channel: 'telegram' }, WEB, opts);
  await Promise.all(done);
  return r;
}

test('after a hold in the bot the client gets the message in their language: one Telegram call, the row is «sent»', async () => {
  const { calls, api } = fakeApi();
  await holdInBot({ send: createSender({ api }) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].chat, 77);
  assert.match(plain(calls[0].text), /^41-kvartira siz uchun 15 daqiqaga band qilindi\. Depozit 10 000 000 so‘m\. 28\.10, 10:15 gacha to‘lang/);
  assert.equal(calls[0].other.parse_mode, 'HTML');
  assert.match(calls[0].other.reply_markup.inline_keyboard[0][0].web_app.url, /^https:\/\/domus\.test\/b\/\d+-/);
  assert.deepEqual(calls[0].other.link_preview_options, { is_disabled: true });
  const row = await db.one("SELECT * FROM outbox WHERE template = 'hold_created'");
  assert.deepEqual([row.status, row.lang, Number(row.tg_message_id), row.attempts], ['sent', 'uz', 901, 1]);
  assert.match(row.rendered.text, /^41-kvartira/, 'the Outbox window shows what was sent');
});

test('a client without Telegram: the row is skipped and nothing is sent; no bot token — the row waits as pending', async () => {
  const { calls, api } = fakeApi();
  const web = await makeClient(db, { name: 'Борис', phone: '+998901234567' });
  const send = createSender({ api });
  await createHold(db, { apartmentNo: 42, client: { id: web.id }, channel: 'telegram' }, WEB, { env: ENV, render: createRender(ENV), onCommit: fx => afterCommit(db, fx, { env: ENV, send }) });
  assert.equal(calls.length, 0);
  assert.equal(createSender({ token: '' }), null);

  await holdInBot({ send: null });
  assert.equal((await db.one("SELECT status FROM outbox WHERE template = 'hold_created' AND chat_id = 77")).status, 'pending');
});

test('Telegram answers: 403 → skipped «blocked» and the client is marked; 429 → retry after retry_after; network → retry with a job; 400 → failed', async () => {
  const cases = [
    [grammyError(403, 'Forbidden: bot was blocked by the user'), 'skipped'],
    [grammyError(429, 'Too Many Requests: retry after 7', { retry_after: 7 }), 'retry'],
    [new HttpError('Network request for sendMessage failed!', new Error('ECONNRESET')), 'retry'],
    [grammyError(400, 'Bad Request: can\'t parse entities'), 'failed']
  ];
  const seen = [];
  for (const [i, [error, want]] of cases.entries()) {
    await resetDb(db);
    fakeClock.set('2026-10-28T10:00:00+05:00');
    const { api } = fakeApi(error);
    await holdInBot({ send: createSender({ api }) });
    const row = await db.one("SELECT * FROM outbox WHERE template = 'hold_created'");
    assert.equal(row.status, want, `case ${i}`);
    seen.push(row);
    if (want === 'skipped') {
      assert.equal(row.skip_reason, 'blocked');
      assert.ok((await db.one('SELECT tg_blocked_at FROM clients WHERE telegram_user_id = 77')).tg_blocked_at);
    }
    if (want === 'retry') {
      const job = await db.one("SELECT * FROM jobs WHERE type = 'outbox.retry'");
      assert.equal(job.payload.outboxId, Number(row.id));
    }
  }
  assert.equal(seen[1].next_attempt_at.toISOString(), '2026-10-28T05:00:07.000Z', 'retry_after 7 s');
  assert.equal(seen[2].next_attempt_at.toISOString(), '2026-10-28T05:00:30.000Z', 'the first network retry is 30 s');
  assert.match(seen[3].last_error, /parse entities/);
});

test('a failed send is repeated by deliver() when the time comes, and the second try is the last word', async () => {
  const flaky = fakeApi(new HttpError('down', new Error('x')));
  await holdInBot({ send: createSender({ api: flaky.api }) });
  const row = await db.one("SELECT * FROM outbox WHERE template = 'hold_created'");
  assert.equal(row.status, 'retry');
  assert.deepEqual(await deliver(db, [row.id], createSender({ api: fakeApi().api })), { sent: 0, retry: 0, skipped: 0, failed: 0 }, 'not yet due');
  fakeClock.advance('31s');
  const ok = fakeApi();
  assert.equal((await deliver(db, [row.id], createSender({ api: ok.api }))).sent, 1);
  assert.equal(ok.calls.length, 1);
  assert.equal((await db.one('SELECT * FROM outbox WHERE id = $1', [row.id])).attempts, 2);
});

test('the sender: edit goes to editMessageText with the saved message id; an unknown op and an empty row are refused politely', async () => {
  const { calls, api } = fakeApi();
  const send = createSender({ api });
  const rendered = render('staff_lead_taken', 'ru', varsOf('staff_lead_taken'), OPTS);
  assert.deepEqual(await send({ op: 'edit', chat_id: -1, edit_message_id: '55', rendered }), { ok: true });
  assert.deepEqual([calls[0].method, calls[0].chat, calls[0].id], ['editMessageText', -1, 55]);
  assert.equal((await send({ op: 'send_document', chat_id: 1, rendered })).status, 400);
  assert.equal((await send({ op: 'send', chat_id: 1, rendered: null })).status, 400);
});

test('a row written without its message is rendered at delivery from template, lang and vars; without render → 400 failed', async () => {
  const { calls, api } = fakeApi();
  const row = { op: 'send', chat_id: 77, template: 'hold_created', lang: 'uz', vars: { apt: 41, min: 15, deposit: 1000000, link: 'https://domus.test/b/1-x' }, rendered: null };
  assert.equal((await createSender({ api, render: createRender(ENV) })(row)).ok, true);
  assert.match(calls[0].text, /^41-kvartira/);
  assert.deepEqual(await createSender({ api })(row), { ok: false, status: 400, description: 'no rendered message' });
});
