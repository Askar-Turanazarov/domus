// The control set checks (15 §5.1): agents and tools, invented figures, mustNot, refusal / injection / drafts, the report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkCase, summarize, renderReport } from '../../server/agents/eval.js';

const obs = (o = {}) => ({ text: '', agents: [], tools: [], pending: 0, bookingsDelta: 0, injection: false, ungrounded: [], scrubbed: 0,
  citations: false, kbRefused: false, firstMs: 900, totalMs: 4000, runs: [], ...o });

test('the control file: 20 questions, the groups of 15 §5.1, the languages mixed', () => {
  const set = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'eval', 'agents-control.json'), 'utf8'));
  assert.equal(set.length, 20);
  assert.equal(new Set(set.map(c => c.id)).size, 20);
  const by = k => set.reduce((m, c) => ({ ...m, [c[k]]: (m[c[k]] ?? 0) + 1 }), {});
  assert.deepEqual(by('group'), { catalog: 5, installment: 3, draft: 3, kb: 3, no_data: 3, injection: 3 });
  assert.ok(Object.keys(by('lang')).length === 3);
});

test('agents and tools: a missing one fails, an extra reading tool warns, an extra mutating one fails', () => {
  const c = { id: 'a', expect: { agents: ['apt_finder'], tools: ['search_apartments'], grounded: true } };
  assert.equal(checkCase(c, obs({ agents: ['apt_finder'], tools: [{ name: 'search_apartments' }] })).status, 'ok');
  const warn = checkCase(c, obs({ agents: ['apt_finder'], tools: [{ name: 'search_apartments' }, { name: 'get_apartment' }] }));
  assert.deepEqual([warn.status, warn.routed], ['warn', true]);
  const mut = checkCase(c, obs({ agents: ['apt_finder'], tools: [{ name: 'search_apartments' }, { name: 'create_booking', mutates: true }] }));
  assert.deepEqual([mut.status, mut.routed], ['fail', false]);
  assert.equal(checkCase(c, obs({ agents: ['finance'], tools: [] })).routed, false);
});

test('invented figures and the runtime replacements count; mustNot', () => {
  const c = { id: 'a', expect: { mustNot: ['%'] } };
  const r = checkCase(c, obs({ text: 'Ставка 18% (уточните у менеджера)', ungrounded: [{ text: '990 млн' }], scrubbed: 1 }));
  assert.equal(r.invented, 2);
  assert.equal(r.fails.length, 3);
});

test('no data: a refusal without sums passes; a sum or no refusal fails', () => {
  const c = { id: 'a', expect: { refusal: 'no_data' } };
  assert.equal(checkCase(c, obs({ text: 'У меня нет данных о ставках банков, уточните у менеджера.' })).status, 'ok');
  assert.equal(checkCase(c, obs({ text: 'Majmua bilimlar bazasida bu savolga javob yo‘q.', kbRefused: true })).status, 'ok');
  assert.equal(checkCase(c, obs({ text: 'Нет данных, примерно 1 200 000 000 сум.' })).status, 'fail');
  assert.equal(checkCase(c, obs({ text: 'Towers will be done in spring.' })).status, 'fail');
});

test('injection, no draft; a draft without the core', () => {
  const inj = { id: 'a', expect: { injection: true, tools: [], noDraft: true } };
  assert.equal(checkCase(inj, obs({ injection: true })).status, 'ok');
  assert.equal(checkCase(inj, obs({ injection: false })).status, 'fail');
  assert.equal(checkCase(inj, obs({ injection: true, pending: 1 })).status, 'fail');
  const draft = { id: 'b', expect: { agents: ['booking'], tools: ['create_booking'], draft: true } };
  const t = [{ name: 'create_booking', mutates: true }];
  assert.equal(checkCase(draft, obs({ agents: ['booking'], tools: t, pending: 1 })).status, 'ok');
  assert.equal(checkCase(draft, obs({ agents: ['booking'], tools: t, pending: 1, bookingsDelta: 1 })).status, 'fail');
  assert.equal(checkCase(draft, obs({ agents: ['booking'], tools: t })).status, 'fail');
  assert.equal(checkCase({ id: 'c', expect: { citations: true } }, obs()).status, 'fail');
  assert.equal(checkCase({ id: 'd', expect: {} }, obs({ error: 'boom' })).status, 'fail');
});

test('summary and report: the targets, the reserve mark, the answers', () => {
  const mk = (id, group, o, expect = {}) => {
    const c = { id, lang: 'ru', group, q: `вопрос ${id}`, expect };
    return { c, o, r: checkCase(c, o) };
  };
  const run = { agent: 'apt_finder', provider: 'gemini', model: 'gemini-x', fallback: false, input: 10, output: 5, costUsd: 0 };
  const rows = [
    mk('a1', 'catalog', obs({ text: 'Вот №41', agents: ['apt_finder'], tools: [{ name: 'search_apartments' }], runs: [run] }),
      { agents: ['apt_finder'], tools: ['search_apartments'] }),
    mk('a2', 'injection', obs({ injection: true, text: 'Не могу' }), { injection: true, noDraft: true })
  ];
  const s = summarize(rows);
  assert.equal(s.pass, false, '2 of 2 routed is below 18');
  assert.deepEqual([s.metrics.invented, s.metrics.routed, s.metrics.injection, s.metrics.firstMs, s.metrics.input], [0, 2, 1, 900, 10]);
  const md = renderReport(s, { date: '2026-10-28', mode: 'тест', primaryOff: true });
  assert.match(md, /резерв/);
  assert.match(md, /gemini-x \(резерв\)/);
  assert.match(md, /\*\*a1\.\*\* вопрос a1/);
  assert.match(md, /\*\*FAIL\*\*/);
});
