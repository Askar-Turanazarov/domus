// 06 §2, §4: chat() walks the role's chain; without ANTHROPIC_API_KEY Claude is skipped (the default mode, D-01).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAi } from '../../server/ai/index.js';
import { chainOf } from '../../server/ai/chains.js';
import { fakeProvider, userMsg } from './fakes.js';

test('chains: tools and fast per D-01; a step can resume on the model it stopped at', () => {
  assert.deepEqual(chainOf('tools').map(c => c.model), ['gemini-3.8-flash', 'gemini-3.6-flash', 'claude-sonnet-5-5']);
  assert.deepEqual(chainOf('fast').map(c => c.model), ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'claude-haiku-5-5']);
  assert.deepEqual(chainOf('tools', { from: 'gemini-3.6-flash' }).map(c => c.index), [1, 2]);
});

test('chat: the first model answers; text streams; result carries provider, model, usage, native', async () => {
  const gemini = fakeProvider('gemini', { '*': [{ text: 'Привет' }] });
  const ai = createAi({ adapters: { gemini, anthropic: null } });
  const ev = [];
  const r = await ai.chat({ role: 'tools', system: 'S', messages: [userMsg('hi')], onEvent: e => ev.push(e) });
  assert.equal(r.model, 'gemini-3.8-flash');
  assert.equal(r.provider, 'gemini');
  assert.equal(r.fallback, false);
  assert.equal(r.stop, 'end');
  assert.deepEqual(ev, [{ type: 'text', delta: 'Привет' }]);
  assert.equal(typeof r.firstEventMs, 'number');
  assert.ok(r.native);
});

test('chat: JSON output is parsed; a bad JSON gives json = null', async () => {
  const gemini = fakeProvider('gemini', { 'gemini-3.5-flash-lite': [{ text: '{"agents":["finance"]}' }, { text: 'not json' }] });
  const ai = createAi({ adapters: { gemini, anthropic: null } });
  const r = await ai.chat({ role: 'fast', system: 'S', messages: [userMsg('x')], output: { schema: {} } });
  assert.deepEqual(r.json, { agents: ['finance'] });
  assert.equal((await ai.chat({ role: 'fast', system: 'S', messages: [userMsg('x')], output: { schema: {} } })).json, null);
});

test('chat: no Claude key → after both Gemini models the chain is empty (scripted), Claude never asked', async () => {
  const gemini = fakeProvider('gemini', { '*': [{ error: 'server' }] });
  const ai = createAi({ adapters: { gemini, anthropic: null } });
  const r = await ai.chat({ role: 'tools', system: 'S', messages: [userMsg('x')] });
  assert.equal(r.stop, 'unavailable');
  assert.equal(r.provider, 'scripted');
  assert.deepEqual(gemini.calls.map(c => c.model), ['gemini-3.8-flash', 'gemini-3.6-flash']);
});

test('chat: tool-call ids continue the turn numbering (tc_<n>)', async () => {
  const gemini = fakeProvider('gemini', { '*': [{ calls: [{ name: 'get_apartment', args: { no: 41 } }] }] });
  const ai = createAi({ adapters: { gemini, anthropic: null } });
  const prior = { role: 'assistant', parts: [{ type: 'tool_call', id: 'tc_1', name: 'x', args: {} }] };
  const r = await ai.chat({ role: 'tools', system: 'S', messages: [userMsg('x'), prior] });
  assert.equal(r.parts[0].id, 'tc_2');
  assert.equal(r.stop, 'tool_calls');
});
