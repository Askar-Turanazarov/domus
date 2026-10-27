import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createSseParser, parseSse, streamChat } from '../../public/js/chat/stream.js';
import { renderMarkdown, ownUrl } from '../../public/js/chat/markdown.js';
import { renderBlock } from '../../public/js/chat/blocks.js';

const ORIGIN = 'https://domus.test';
const { document: doc } = parseHTML('<!doctype html><html><body></body></html>');
const html = text => {
  const box = doc.createElement('div');
  box.append(renderMarkdown(text, { doc, origin: ORIGIN }));
  return box;
};
const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const bodyOf = (...chunks) => new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(x); c.close(); } });
const okRes = (...chunks) => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream; charset=utf-8' }), body: bodyOf(...chunks) });

test('parser: events in one piece, comments and pings are skipped', () => {
  const got = [...parseSse(`: ping\n\n${ev('status', { text: 'a' })}${ev('text', { delta: 'б' })}`)];
  assert.deepEqual(got.map(e => e.event), ['status', 'text']);
  assert.equal(got[1].data.delta, 'б');
});

test('parser: any split gives the same events, even in the middle of a word', () => {
  const text = ev('text', { delta: 'Привет' }) + ev('done', { messageId: 7 });
  for (let cut = 1; cut < text.length; cut += 3) {
    const out = [];
    const p = createSseParser(e => out.push(e));
    p.push(text.slice(0, cut));
    p.push(text.slice(cut));
    p.end();
    assert.deepEqual(out.map(e => e.event), ['text', 'done'], `cut at ${cut}`);
    assert.equal(out[0].data.delta, 'Привет');
  }
});

test('parser: CRLF lines and a broken JSON event', () => {
  const out = [...parseSse('event: text\r\ndata: {"delta":"x"}\r\n\r\nevent: text\ndata: {oops\n\nevent: done\ndata: {}\n\n')];
  assert.deepEqual(out.map(e => e.event), ['text', 'done']);
});

test('streamChat: multi-byte letters split between network chunks', async () => {
  const bytes = new TextEncoder().encode(ev('text', { delta: 'Квартира №41' }) + ev('done', { messageId: 1 }));
  const at = bytes.indexOf(0xd0) + 1;           // inside the first Cyrillic letter
  const got = [];
  await streamChat('/api/chat', { text: 'x' }, e => got.push(e), { fetchImpl: async () => okRes(bytes.slice(0, at), bytes.slice(at)) });
  assert.equal(got[0].data.delta, 'Квартира №41');
  assert.equal(got.at(-1).event, 'done');
});

test('streamChat: a non-stream answer rejects with the status and the JSON', async () => {
  const res = { ok: false, status: 409, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ error: 'turn_in_progress' }) };
  await assert.rejects(streamChat('/api/chat', {}, () => {}, { fetchImpl: async () => res }), e => e.status === 409 && e.body.error === 'turn_in_progress');
});

test('markdown: bold, lists, paragraphs', () => {
  const box = html('Привет, **мир**\n\n- один\n- два\n\n1. раз\n2. два');
  assert.equal(box.querySelector('strong').textContent, 'мир');
  assert.equal(box.querySelectorAll('ul li').length, 2);
  assert.equal(box.querySelectorAll('ol li').length, 2);
});

test('markdown: model text never becomes HTML', () => {
  const box = html('<script>alert(1)</script> <img src=x onerror=alert(1)> **ok**');
  assert.equal(box.querySelector('script'), null);
  assert.equal(box.querySelector('img'), null);
  assert.match(box.textContent, /<script>alert\(1\)<\/script>/);
});

test('markdown: only own links are links', () => {
  const box = html('[свой](/building.html#apt=41) [чужой](https://evil.example/x) [js](javascript:alert(1)) https://domus.test/ru#apt=3. См. https://evil.example');
  const hrefs = [...box.querySelectorAll('a')].map(a => a.getAttribute('href'));
  assert.deepEqual(hrefs, ['/building.html#apt=41', 'https://domus.test/ru#apt=3']);
  assert.match(box.textContent, /чужой \(https:\/\/evil\.example\/x\)/);
  assert.ok(!box.innerHTML.includes('javascript:alert(1)"'));
  assert.equal(ownUrl('//evil.example', ORIGIN), null);
  assert.equal(ownUrl(String.raw`/\evil.example`, ORIGIN), null);
});

const T = (key, vars = {}) => key + Object.entries(vars).map(([k, v]) => `|${k}=${v}`).join('');
const ctx = (over = {}) => ({ t: T, doc, origin: ORIGIN, onOpen() {}, onSuggest() {}, onConfirm() {}, ...over });

test('blocks: apartment cards open the showcase, «book» only for a free one', () => {
  const calls = [];
  const node = renderBlock({ type: 'apartments', data: { items: [
    { no: 41, rooms: 2, area: 58.4, floor: 5, price: 700000000, status: 'free' },
    { no: 42, rooms: 1, area: 40, floor: 5, price: 500000000, status: 'sold' }] } }, ctx({ onOpen: (no, o) => calls.push([no, o.book]) }));
  const cards = node.querySelectorAll('.chat-apt');
  assert.equal(cards.length, 2);
  const buttons = [...cards[0].querySelectorAll('button')];
  assert.equal(buttons.length, 2);
  buttons[1].click();
  assert.deepEqual(calls, [[41, true]]);
  assert.equal(cards[1].querySelectorAll('button').length, 1);
});

test('blocks: the installment table', () => {
  const node = renderBlock({ type: 'table', data: { tool: 'calc_installment', price: 700000000,
    plans: [{ months: 12, down: 210000000, monthly: 40000000, markup: 12000000 }] } }, ctx());
  assert.equal(node.querySelectorAll('tr').length, 2);
  assert.match(node.textContent, /chat\.t\.months\|n=12/);
});

test('blocks: the confirmation card passes the answer once and locks the buttons', () => {
  const got = [];
  const node = renderBlock({ type: 'confirm', data: { pendingActionId: 'p1', title: 'Бронь №41', lines: ['Цена 700 000 000'],
    buttons: [{ label: 'Да', action: 'yes', data: 'pa:p1:y' }, { label: 'Отмена', action: 'cancel', data: 'pa:p1:n' }] } }, ctx({ onConfirm: b => got.push(b.action) }));
  const [yes, no] = node.querySelectorAll('button');
  yes.click();
  assert.deepEqual(got, ['yes']);
  assert.ok(yes.disabled && no.disabled);
});

test('blocks: the booking card shows the texts as plain text and the link as a button to our own domain only', () => {
  const card = url => ({ title: '🏢 ЖК <b>X</b>', lines: ['Ваша бронь №1002', 'Квартира №39'], note: 'Спасибо!', url, label: '📄 Моя бронь' });
  const node = renderBlock({ type: 'bookings', data: { items: [card('/b/1002-x'), card('https://evil.example/b/1')] } }, ctx());
  assert.equal(node.querySelectorAll('.chat-apt').length, 2);
  assert.match(node.textContent, /Квартира №39/);
  assert.equal(node.querySelectorAll('b').length, 0, 'a text never becomes HTML');
  const links = node.querySelectorAll('a');
  assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute('href'), '/b/1002-x');
});

test('blocks: suggestions keep own links only; unknown blocks are not drawn', () => {
  const node = renderBlock({ type: 'suggestions', data: [
    { label: 'Оплатить', url: '/pay/x' }, { label: 'Чужое', url: 'https://evil.example' }, { label: 'Ещё', intent: 'show_free', payload: {} }] }, ctx());
  assert.equal(node.querySelectorAll('a').length, 1);
  assert.equal(node.querySelectorAll('button').length, 1);
  assert.equal(renderBlock({ type: 'press', data: {} }, ctx()), null);
});

test('blocks: citations — a button per source, a press opens the fragment as text (never HTML) with the match and the mode, a second press closes', () => {
  const data = { mode: 'keyword_only', items: [{ n: 1, heading: 'Сроки — Когда', text: '<img src=x onerror=alert(1)> Q4 2027', score: 0.812 }, { n: 2, heading: 'Паркинг', text: 'Есть', score: null }] };
  const node = renderBlock({ type: 'citations', data }, ctx());
  const [b1, b2] = node.querySelectorAll('button');
  assert.deepEqual([b1.textContent, b2.textContent], ['[1]', '[2]']);
  const panel = node.querySelector('.chat-cite-panel');
  assert.equal(panel.hidden, true);
  b1.click();
  assert.equal(panel.hidden, false);
  assert.match(panel.textContent, /chat\.cite · \[1\] Сроки — Когда/);
  assert.match(panel.textContent, /<img src=x onerror=alert\(1\)> Q4 2027/);
  assert.equal(panel.querySelector('img'), null);
  assert.match(panel.textContent, /chat\.match\|pct=81/);
  assert.match(panel.textContent, /chat\.mode\.keyword_only/);
  b1.click();
  assert.equal(panel.hidden, true);
  assert.equal(renderBlock({ type: 'citations', data: { items: [] } }, ctx()), null);
});
