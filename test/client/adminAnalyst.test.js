// 12 §11: the «Аналитик» screen — three starter questions, a press posts to /api/admin/analyst with the CSRF header, the streamed text
// as safe Markdown, the table from the block (text only) with «Открыть в админке», the dialog id kept for the next question.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { document } = parseHTML('<!doctype html><html><body><div id="root"></div><div id="toast" hidden></div></body></html>');
globalThis.document = document;

const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const sse = text => {
  const bytes = new TextEncoder().encode(text);
  let done = false;
  return { ok: true, status: 200, headers: { get: () => 'text/event-stream; charset=utf-8' },
    body: { getReader: () => ({ read: async () => (done ? { done: true } : (done = true, { done: false, value: bytes })) }) } };
};
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
  return sse(frame('meta', { conversationId: 'c-1' }) + frame('status', { text: 'Думаю…' })
    + frame('text', { agent: 'analyst', delta: 'Завтра сгорают **2** брони <img src=x onerror=alert(1)>' })
    + frame('block', { type: 'table', data: { tool: 'list_bookings', total: 2, columns: ['Бронь', 'Клиент'], rows: [['№1042', '<b>Аня</b>'], ['№1043', 'Олег']], link: '#/bookings' } })
    + frame('done', { turnId: 't', messageId: 1 }));
};

const { mount } = await import('../../public/admin/views/analyst.js');
const tick = () => new Promise(r => setTimeout(r, 0));

test('starters, the post with CSRF, the safe text, the table and the link; the dialog id goes with the next question', async () => {
  const root = document.getElementById('root');
  const went = [];
  mount(root, { staff: { role: 'head' }, params: [], go: id => went.push(id) });
  const starters = [...root.querySelectorAll('.an-starters button')].map(b => b.textContent);
  assert.deepEqual(starters, ['Какие брони сгорают завтра?', 'Сравни продажи этой и прошлой недели', 'Сколько стоил ИИ за неделю?']);
  root.querySelector('.an-starters button').click();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(calls[0].url, '/api/admin/analyst');
  assert.equal(calls[0].headers['X-Requested-With'], 'domus-admin');
  assert.equal(calls[0].body.text, 'Какие брони сгорают завтра?');
  const bot = root.querySelector('.an-msg.bot');
  assert.equal(bot.querySelector('strong').textContent, '2');
  assert.equal(bot.querySelector('img'), null, 'the model text never becomes HTML');
  assert.deepEqual([...bot.querySelectorAll('td')].map(td => td.textContent), ['№1042', '<b>Аня</b>', '№1043', 'Олег']);
  bot.querySelector('a.btn').click();
  assert.deepEqual(went, ['bookings']);

  root.querySelector('.an-input').value = 'А послезавтра?';
  root.querySelector('.an-form').dispatchEvent(new document.defaultView.Event('submit'));
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(calls[1].body.conversationId, 'c-1');
});
