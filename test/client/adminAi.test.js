// 12 §8: the AI screen — tabs by role (a manager has no tools / costs), the list of turns with the reserve mark and filters going to the
// server, the tree of a turn with server text kept as text, the costs with today's budget, the knowledge base with the reindex and «without an answer».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div><div id="toast" hidden></div></body></html>');
globalThis.document = document;
globalThis.history = { replaceState() {} };
const EVIL = '<img src=x onerror=alert(1)>';
const TURN = '55555555-5555-4555-8555-555555555555';
const iso = ms => new Date(Date.now() + ms).toISOString();

const run = (id, extra = {}) => ({ turnId: id, at: iso(-60e3), channel: 'web', client: { id: 'c1', name: EVIL }, agents: ['router', 'apt_finder'], tools: ['search_apartments'], model: 'gemini-3.8-flash',
  provider: 'gemini', fallback: false, ms: 1200, firstEventMs: 300, tokens: { input: 200, output: 40, cached: 0 }, costUsd: 0.0123, ok: true, error: null, feedback: null, problem: false, ...extra });
const runs = { items: [run(TURN), run('66666666-6666-4666-8666-666666666666', { fallback: true, ok: false, error: 'max_steps', feedback: -1 })], next: null };
const tree = { turnId: TURN, at: iso(-60e3), conversation: { id: 'v1', channel: 'web', lang: 'ru', client: { id: 'c1', name: EVIL } },
  messages: [{ role: 'user', text: EVIL, feedback: null, note: null, at: iso(-60e3) }, { role: 'assistant', text: 'Три варианта', feedback: -1, note: 'долго', at: iso(-59e3) }],
  steps: [{ agent: 'router', role: 'fast', provider: 'gemini', model: 'gemini-3.5-flash-lite', fallback: false, steps: 1, ms: 300, firstEventMs: 200, tokens: { input: 100, output: 20, cached: 0 }, costUsd: 0.001, ok: true, error: null, calls: [], tools: [] },
    { agent: 'apt_finder', role: 'tools', provider: 'anthropic', model: 'claude-sonnet-5-5', fallback: true, steps: 2, ms: 900, firstEventMs: 400, tokens: { input: 100, output: 20, cached: 0 }, costUsd: 0.01, ok: true, error: null,
      calls: [{ at: iso(0), provider: 'gemini', model: 'gemini-3.8-flash', kind: 'chat', ok: false, errorClass: 'rate_minute', tokens: { input: 0, output: 0, cached: 0 }, costUsd: 0, ms: 50 }],
      tools: [{ id: 1, tool: 'search_apartments', phase: null, args: { rooms: 2 }, ok: true, error: null, ms: 35 }] }], otherTools: [] };
const costs = { days: [{ day: '2026-10-28', calls: 3, failed: 0, input: 300, output: 60, cached: 0, costUsd: 0.45, byModel: [{ provider: 'gemini', model: 'gemini-3.8-flash', calls: 2, costUsd: 0.04 }], fallbackShare: 0.5 }],
  totals: { calls: 3, costUsd: 0.45 }, today: { paidUsd: 0.41, budgetUsd: 5, gemini: [{ model: 'gemini-3.8-flash', used: 312, limit: 1500 }] }, geminiTier: 'free' };
const chunks = { items: [{ id: 1, lang: 'ru', file: 'kb/ru/parking.md', slug: 'parking', title: 'Паркинг', topic: 'паркинг', heading: 'Места', length: 33, text: EVIL, hash: 'abcdef012345', indexedAt: iso(-86400e3), hasVector: false }], topics: ['паркинг'] };
const unanswered = { groups: [{ query: 'Есть ли детская площадка?', lang: 'ru', count: 3, lastAt: iso(-1000) }], keywordOnly: 2, days: 30 };

const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), method = init.method ?? 'GET';
  calls.push({ url: u, method, body: init.body ? JSON.parse(init.body) : undefined });
  const answer = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  if (method === 'POST' && u === '/api/admin/kb/reindex') return answer({ changed: 4, deleted: 1, total: 60, documents: 20, partial: false, ms: 900 });
  if (u.startsWith('/api/admin/ai/runs/')) return answer(tree);
  if (u.startsWith('/api/admin/ai/runs')) return answer(runs);
  if (u.startsWith('/api/admin/ai/tools')) return answer({ items: [{ id: 1, at: iso(0), source: 'mcp', role: 'head', tool: 'sales_summary', phase: null, args: { period: 'week' }, ok: true, error: null, ms: 12 }], next: null });
  if (u.startsWith('/api/admin/ai/costs')) return answer(costs);
  if (u.startsWith('/api/admin/kb/chunks')) return answer(chunks);
  if (u.startsWith('/api/admin/kb/unanswered')) return answer(unanswered);
  throw new Error('unexpected ' + method + ' ' + u);
};

const { mount } = await import('../../public/admin/views/ai.js');
const tick = (ms = 25) => new Promise(r => setTimeout(r, ms));

async function open(t, role = 'head', params = []) {
  calls.length = 0;
  const root = document.createElement('div');
  document.body.append(root);
  const stop = mount(root, { staff: { role }, params });
  t.after(stop);
  await tick();
  return root;
}

test('tabs follow the role: a manager has the journal and the base only', async t => {
  assert.deepEqual([...(await open(t, 'manager')).querySelectorAll('[data-tab]')].map(b => b.dataset.tab), ['runs', 'kb']);
  assert.deepEqual([...(await open(t, 'head')).querySelectorAll('[data-tab]')].map(b => b.dataset.tab), ['runs', 'tools', 'costs', 'kb']);
});

test('turns: a row per turn, the reserve mark, 👎, names as text; a filter goes to the server', async t => {
  const root = await open(t);
  const rows = [...root.querySelectorAll('tbody tr')];
  assert.equal(rows.length, 2);
  assert.ok(rows[0].textContent.includes(EVIL));
  assert.equal(rows[0].querySelector('img'), null);
  assert.match(rows[1].textContent, /резерв/);
  assert.match(rows[1].textContent, /max_steps/);
  assert.match(rows[1].textContent, /👎/);
  const box = root.querySelector('input[name="problem"]');
  box.checked = true;
  box.dispatchEvent(new window.Event('change'));
  await tick();
  assert.ok(calls.some(c => /ai\/runs\?problem=1/.test(c.url)));
});

test('the tree of a turn: steps in order, model calls with the error class, tools with masked arguments, the dialogue as text', async t => {
  const root = await open(t);
  root.querySelector(`tr[data-turn="${TURN}"]`).click();
  await tick();
  const tr = root.querySelector('[data-part="tree"]');
  assert.deepEqual([...tr.children].map(li => li.querySelector('b').textContent), ['router', 'apt_finder']);
  assert.match(tr.textContent, /rate_minute/);
  assert.match(tr.textContent, /search_apartments/);
  assert.match(tr.textContent, /"rooms":2/);
  const side = root.querySelector('.adm2-side');
  assert.ok(side.textContent.includes(EVIL));
  assert.equal(side.querySelector('img'), null);
  assert.match(side.textContent, /долго/);
});

test('costs: today against the budget, Gemini requests, the days table', async t => {
  const root = await open(t);
  root.querySelector('[data-tab="costs"]').click();
  await tick();
  assert.match(root.textContent, /Сегодня: \$0\.4100 из \$5\.00/);
  assert.match(root.textContent, /gemini-3\.8-flash: 312 \/ 1500/);
  assert.equal(root.querySelector('tbody tr td').textContent, '2026-10-28');
  assert.equal(Number(root.querySelector('progress.adm2-meter').value), 8);
});

test('tools: rows with the source label; a filter goes to the server', async t => {
  const root = await open(t);
  root.querySelector('[data-tab="tools"]').click();
  await tick();
  assert.match(root.querySelector('tbody').textContent, /mcp:head/);
  assert.match(root.querySelector('tbody').textContent, /sales_summary/);
  const sel = root.querySelector('select[name="source"]');
  [...sel.options].find(o => o.value === 'mcp').selected = true;
  sel.dispatchEvent(new window.Event('change'));
  await tick();
  assert.ok(calls.some(c => /ai\/tools\?source=mcp/.test(c.url)));
});

test('knowledge base: chunks, the text of a chunk as text, «without an answer», the reindex for the head only', async t => {
  const root = await open(t);
  root.querySelector('[data-tab="kb"]').click();
  await tick();
  assert.match(root.querySelector('tbody').textContent, /kb\/ru\/parking\.md/);
  assert.match(root.querySelector('tbody').textContent, /нет вектора/);
  root.querySelector('tr[data-chunk="1"]').click();
  assert.ok(root.querySelector('[data-part="chunk-text"]').textContent.includes(EVIL));
  assert.equal(root.querySelector('[data-part="chunk-text"] img'), null);
  assert.match(root.querySelector('[data-block="unanswered"]').textContent, /детская площадка/);
  assert.match(root.querySelector('[data-block="unanswered"]').textContent, /×3/);
  assert.match(root.querySelector('[data-block="unanswered"]').textContent, /: 2/);

  calls.length = 0;
  root.querySelector('[data-act="reindex"]').click();
  await tick();
  assert.ok(calls.some(c => c.method === 'POST' && c.url === '/api/admin/kb/reindex'));
  assert.match(document.getElementById('toast').textContent, /Изменено 4 фрагментов из 60, удалено 1/);

  const mgr = await open(t, 'manager', ['kb']);
  await tick();
  assert.equal(mgr.querySelector('[data-act="reindex"]'), null);
});
