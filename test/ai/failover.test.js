// 06 §4, §8, §10: a failing model is passed over without a wait; the user never sees the error.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createAi } from '../../server/ai/index.js';
import { createHealth } from '../../server/ai/health.js';
import { fakeProvider, userMsg } from './fakes.js';
import { createTestDb, resetDb } from '../support/db.js';

const msgs = [userMsg('x')];
const models = p => p.calls.map(c => c.model);

test('429 → the next model at once; the model cools down for retryMs', async () => {
  let t = new Date('2026-10-28T10:00:00Z').getTime();
  const now = () => new Date(t);
  const gemini = fakeProvider('gemini', { 'gemini-3.8-flash': [{ error: 'rate_minute', retryMs: 30_000 }, { text: 'ok' }], '*': [{ text: 'ok' }] });
  const ai = createAi({ adapters: { gemini, anthropic: null }, now });
  const r = await ai.chat({ role: 'tools', system: 'S', messages: msgs });
  assert.equal(r.model, 'gemini-3.6-flash');
  assert.equal(r.fallback, true);
  await ai.chat({ role: 'tools', system: 'S', messages: msgs });
  assert.deepEqual(models(gemini), ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.6-flash'], 'cooling model skipped');
  t += 31_000;
  await ai.chat({ role: 'tools', system: 'S', messages: msgs });
  assert.equal(models(gemini).at(-1), 'gemini-3.8-flash', 'back after the cooldown');
});

test('500 once → next model; twice in 2 minutes → cooldown 60 s', async () => {
  const t = new Date('2026-10-28T10:00:00Z').getTime();
  const gemini = fakeProvider('gemini', { 'gemini-3.8-flash': [{ error: 'server' }], '*': [{ text: 'ok' }] });
  const ai = createAi({ adapters: { gemini, anthropic: null }, now: () => new Date(t) });
  await ai.chat({ role: 'tools', system: 'S', messages: msgs });
  assert.equal(ai.health.skip('gemini-3.8-flash', 'gemini'), null, 'one 500 is not a cooldown');
  await ai.chat({ role: 'tools', system: 'S', messages: msgs });
  assert.equal(ai.health.skip('gemini-3.8-flash', 'gemini'), 'server');
});

test('timeout before the first byte → next model within the role budget', async () => {
  const gemini = fakeProvider('gemini', { 'gemini-3.5-flash-lite': [{ wait: 1000, text: 'late' }], '*': [{ text: 'ok' }] });
  const ai = createAi({ adapters: { gemini, anthropic: null }, env: { AI_TIMEOUTS: '{"fast":{"firstByteMs":30,"totalMs":200}}' } });
  const t0 = performance.now();
  const r = await ai.chat({ role: 'fast', system: 'S', messages: msgs });
  assert.equal(r.model, 'gemini-3.1-flash-lite');
  assert.ok(performance.now() - t0 < 500);
});

test('network drop before the first byte → one immediate retry of the same model', async () => {
  const gemini = fakeProvider('gemini', { 'gemini-3.8-flash': [{ error: 'network', early: true }, { text: 'ok' }] });
  const r = await createAi({ adapters: { gemini, anthropic: null } }).chat({ role: 'tools', system: 'S', messages: msgs });
  assert.equal(r.model, 'gemini-3.8-flash');
  assert.deepEqual(models(gemini), ['gemini-3.8-flash', 'gemini-3.8-flash']);
});

test('malformed function call → one retry, then the next model', async () => {
  const gemini = fakeProvider('gemini', { 'gemini-3.8-flash': [{ error: 'malformed' }], '*': [{ text: 'ok' }] });
  const r = await createAi({ adapters: { gemini, anthropic: null } }).chat({ role: 'tools', system: 'S', messages: msgs });
  assert.deepEqual(models(gemini), ['gemini-3.8-flash', 'gemini-3.8-flash', 'gemini-3.6-flash']);
  assert.equal(r.model, 'gemini-3.6-flash');
});

test('400 → straight to the other provider, not along the same one', async () => {
  const gemini = fakeProvider('gemini', { '*': [{ error: 'bad_request', status: 400 }] });
  const anthropic = fakeProvider('anthropic', { '*': [{ text: 'ok' }] });
  const r = await createAi({ adapters: { gemini, anthropic }, log: { error() {} } }).chat({ role: 'tools', system: 'S', messages: msgs });
  assert.deepEqual(models(gemini), ['gemini-3.8-flash']);
  assert.equal(r.model, 'claude-sonnet-5-5');
});

test('no Claude key → Claude is skipped without a request; with a key it is the last resort', async () => {
  const gemini = fakeProvider('gemini', { '*': [{ error: 'overloaded' }] });
  const anthropic = fakeProvider('anthropic', { '*': [{ text: 'ok' }] });
  const r = await createAi({ adapters: { gemini, anthropic } }).chat({ role: 'fast', system: 'S', messages: msgs });
  assert.equal(r.model, 'claude-haiku-5-5');
  const r2 = await createAi({ adapters: { gemini, anthropic: null } }).chat({ role: 'fast', system: 'S', messages: msgs });
  assert.equal(r2.provider, 'scripted');
});

test('refusal → returned as is, no switch', async () => {
  const gemini = fakeProvider('gemini', { '*': [{ stop: 'refusal' }] });
  const r = await createAi({ adapters: { gemini, anthropic: null } }).chat({ role: 'tools', system: 'S', messages: msgs });
  assert.equal(r.stop, 'refusal');
  assert.deepEqual(models(gemini), ['gemini-3.8-flash']);
});

test('failure after text → reset event; the next model writes anew', async () => {
  const gemini = fakeProvider('gemini', { 'gemini-3.8-flash': [{ afterText: 'Нача', error: 'server' }], '*': [{ text: 'Готово' }] });
  const ev = [];
  await createAi({ adapters: { gemini, anthropic: null } }).chat({ role: 'tools', system: 'S', messages: msgs, onEvent: e => ev.push(e) });
  assert.deepEqual(ev.map(e => e.type), ['text', 'reset', 'text']);
});

test('auth → the whole provider is off; from resumes at the stopped model; turn deadline', async () => {
  const gemini = fakeProvider('gemini', { '*': [{ error: 'auth', status: 403 }] });
  const ai = createAi({ adapters: { gemini, anthropic: null } });
  await ai.chat({ role: 'tools', system: 'S', messages: msgs });
  assert.deepEqual(models(gemini), ['gemini-3.8-flash'], 'auth disables gemini for all models');
  assert.equal(ai.health.skip('gemini-3.5-flash-lite', 'gemini'), 'auth');

  const g2 = fakeProvider('gemini', { '*': [{ text: 'ok' }] });
  const ai2 = createAi({ adapters: { gemini: g2, anthropic: null } });
  assert.equal((await ai2.chat({ role: 'tools', system: 'S', messages: msgs, from: 'gemini-3.6-flash' })).model, 'gemini-3.6-flash');
  const late = await ai2.chat({ role: 'tools', system: 'S', messages: msgs, deadline: Date.now() - 1 });
  assert.equal(late.stop, 'turn_timeout');
});

let db;
before(async () => { db = await createTestDb(); });
beforeEach(async () => { await resetDb(db); });
after(async () => { await db.close(); });

test('ai_calls: one row per request, ok or failed; health shared through ai_provider_state', async () => {
  const gemini = fakeProvider('gemini', { 'gemini-3.8-flash': [{ error: 'rate_day' }], '*': [{ text: 'ok' }] });
  const ai = createAi({ db, adapters: { gemini, anthropic: null } });
  await ai.chat({ role: 'tools', agent: 'apt_finder', system: 'S', messages: msgs });
  const rows = await db.query('SELECT model, ok, error_class FROM ai_calls ORDER BY id');
  assert.deepEqual(rows.map(r => [r.model, r.ok, r.error_class]), [['gemini-3.8-flash', false, 'rate_day'], ['gemini-3.6-flash', true, null]]);
  // another instance sees the cooldown on its first read
  const other = createHealth({ db });
  await other.refresh(true);
  assert.equal(other.skip('gemini-3.8-flash', 'gemini'), 'rate_day');
  // a model near its minute limit is skipped by the guard, without a 429
  for (let i = 0; i < 14; i++) await db.query("INSERT INTO ai_calls (at, provider, model, kind, ok) VALUES ($1, 'gemini', 'gemini-3.6-flash', 'chat', true)", [new Date()]);
  const g2 = fakeProvider('gemini', { '*': [{ text: 'ok' }] });
  const r = await createAi({ db, adapters: { gemini: g2, anthropic: null } }).chat({ role: 'tools', system: 'S', messages: msgs });
  assert.equal(r.provider, 'scripted');
  assert.equal(g2.calls.length, 0);
});
