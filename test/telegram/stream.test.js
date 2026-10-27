// 10 §5: the look of an answer (HTML, splitting, the table) and the stream (the draft not more often than every 800 ms, the fallback to «печатает…»).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock } from '../../server/core/clock.js';
import { t } from '../../server/i18n/index.js';
import { toHtml, splitText, tableHtml, LIMIT } from '../../server/telegram/format.js';
import { createReplyStream, resetDraftMode, DRAFT_EVERY_MS } from '../../server/telegram/stream.js';

beforeEach(() => { fakeClock.set('2026-10-28T10:00:00+05:00'); resetDraftMode(); });
afterEach(() => fakeClock.reset());

test('10 §5.2: ** → <b>, lists → «•», the special characters are escaped', () => {
  assert.equal(toHtml('**Цена** 1 < 2 & 3 > 0\n- один\n* два'), '<b>Цена</b> 1 &lt; 2 &amp; 3 &gt; 0\n• один\n• два');
  assert.equal(toHtml('<script>x</script>'), '&lt;script&gt;x&lt;/script&gt;');
});

test('10 §5.2: links — only to our own site; a foreign address is plain text', () => {
  const base = 'https://domus.test';
  assert.equal(toHtml('[3D](/ru#apt=41)', { base }), '<a href="https://domus.test/ru#apt=41">3D</a>');
  assert.equal(toHtml('[сайт](https://domus.test/ru)', { base }), '<a href="https://domus.test/ru">сайт</a>');
  assert.equal(toHtml('[чужой](https://evil.example/x) [js](javascript:x)', { base }), 'чужой js');
});

test('10 §5.2: more than 4096 characters → several messages by paragraphs, each within the limit, no tag torn', () => {
  const para = n => `**П${n}** ` + 'слово '.repeat(120);
  const text = Array.from({ length: 12 }, (_, i) => para(i)).join('\n\n');
  const parts = splitText(text);
  assert.ok(parts.length > 1);
  for (const p of parts) {
    assert.ok(p.length <= LIMIT);
    assert.equal((p.match(/<b>/g) ?? []).length, (p.match(/<\/b>/g) ?? []).length);
  }
  const hard = splitText('я'.repeat(10000));
  assert.ok(hard.length >= 3 && hard.every(p => p.length <= LIMIT));
  assert.deepEqual(splitText('   '), []);
});

test('10 §5.2: the table — <pre>, up to 6 rows, «more» when longer', () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ kind: 'installment', months: 12 + i, down: 100e6, monthly: 30e6, overpay: 5e6 }));
  const r = tableHtml({ rows }, t, 'ru');
  assert.match(r.html, /^<pre>/);
  assert.equal(r.html.split('\n').length, 7, 'the head and 6 rows');
  assert.equal(r.more, true);
  assert.equal(tableHtml({ plans: [{ months: 12, down: 1, monthly: 2, markup: 3 }] }, t, 'ru').more, false);
});

function fakeApi({ draft = true } = {}) {
  const calls = [];
  const api = {
    sendChatAction: async (chat, action) => { calls.push(['action', action]); return true; },
    raw: { sendMessageDraft: async p => {
      calls.push(['draft', p.text, p.draft_id]);
      if (!draft) throw Object.assign(new Error('Not Found'), { error_code: 404 });
      return true;
    } }
  };
  return { api, calls };
}
const drafts = calls => calls.filter(c => c[0] === 'draft');

test('10 §5.1: typing at the start; a status → a draft; the text → not more often than 800 ms and by ≥ 20 characters', async () => {
  const { api, calls } = fakeApi();
  const s = createReplyStream({ api, chatId: 1, draftId: 7 });
  s.event({ type: 'status', data: { text: 'Подбираю квартиры…' } });
  s.event({ type: 'text', delta: 'Нашёл три варианта, ' });              // 20 characters, but the status was just now
  fakeClock.advance(500);
  s.event({ type: 'text', delta: 'вот первый из них. ' });                // 39 characters, 500 ms — too early
  fakeClock.advance(DRAFT_EVERY_MS);
  s.event({ type: 'text', delta: 'Ещё ' });                               // 43 characters, 1300 ms — time is ok, characters are new ≥ 20
  s.event({ type: 'text', delta: 'немного текста' });                      // right after the last draft — waits for the next 800 ms
  await s.stop();
  assert.equal(calls[0][1], 'typing');
  assert.deepEqual(drafts(calls).map(c => c[1]), ['Подбираю квартиры…', 'Нашёл три варианта, вот первый из них. Ещё ']);
  assert.ok(drafts(calls).every(c => c[2] === 7), 'one draft_id for one reply');
});

test('10 §5.1: a short text under 20 new characters gives no draft; reset → «Секунду…»', async () => {
  const { api, calls } = fakeApi();
  const s = createReplyStream({ api, chatId: 1, draftId: 7, resetText: 'Секунду…' });
  s.event({ type: 'text', delta: 'Да' });
  fakeClock.advance(2000);
  s.event({ type: 'text', delta: '.' });
  s.event({ type: 'reset' });
  await s.stop();
  assert.deepEqual(drafts(calls).map(c => c[1]), ['Секунду…']);
});

test('10 §5.1: without sendMessageDraft (404) → «печатает…» every 4 s, no more drafts, remembered by the instance', async () => {
  const a = fakeApi({ draft: false });
  const s = createReplyStream({ api: a.api, chatId: 1, draftId: 7, typingEveryMs: 10 });
  s.event({ type: 'status', data: { text: 'Считаю…' } });
  await new Promise(r => setTimeout(r, 60));
  await s.stop();
  assert.equal(drafts(a.calls).length, 1, 'one try, then no more');
  assert.ok(a.calls.filter(c => c[0] === 'action').length >= 3, 'typing repeats');
  // the next reply does not try the method again
  const b = fakeApi({ draft: false });
  const s2 = createReplyStream({ api: b.api, chatId: 1, draftId: 8, typingEveryMs: 10 });
  s2.event({ type: 'status', data: { text: 'Ещё…' } });
  await new Promise(r => setTimeout(r, 30));
  await s2.stop();
  assert.equal(drafts(b.calls).length, 0);
});

test('10 §5.1: a failure other than 404/400 does not switch the mode and does not break the turn', async () => {
  const warns = [];
  const api = { sendChatAction: async () => true, raw: { sendMessageDraft: async () => { throw Object.assign(new Error('x'), { error_code: 429 }); } } };
  const s = createReplyStream({ api, chatId: 1, draftId: 1, log: { warn: (...a) => warns.push(a) } });
  s.event({ type: 'status', data: { text: 'a' } });
  await s.stop();
  assert.equal(warns.length, 1);
});
