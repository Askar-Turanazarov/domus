// 06 §14: the cost formula on the numbers of §14.2; the daily Anthropic budget (D-21); the demo switches of §11.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { costOf } from '../../server/ai/cost.js';
import { createAi } from '../../server/ai/index.js';
import { createSettings } from '../../server/core/settings.js';
import { fakeProvider, userMsg } from './fakes.js';
import { createTestDb, resetDb } from '../support/db.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 0.00005, `${a} ≈ ${b}`);

test('cost §14.2: router, Gemini agent step, cache, Claude', () => {
  near(costOf('gemini-3.5-flash-lite', { input: 1500, output: 60, cached: 0 }), 0.0006);
  near(costOf('gemini-3.8-flash', { input: 10000, output: 300, cached: 0 }), 0.0075 + 0.0011);
  near(2 * costOf('gemini-3.8-flash', { input: 10000, output: 300, cached: 6000 }), 0.0092);
  near(costOf('claude-haiku-5-5', { input: 1500, output: 60, cached: 0 }), 0.0002);
  near(costOf('claude-sonnet-5-5', { input: 10000, output: 300, cached: 0 }), 0.023);
  // a cache write costs its own price, not the input one
  near(costOf('claude-sonnet-5-5', { input: 10000, output: 0, cached: 0, cacheWrite: 6000 }), (4000 * 2 + 6000 * 2.5) / 1e6);
  assert.equal(costOf('unknown', { input: 1 }), 0);
});

const msgs = [userMsg('x')];
let db;
before(async () => { db = await createTestDb(); });
beforeEach(async () => { await resetDb(db); });
after(async () => { await db.close(); });

test('budget: Claude spending over AI_DAILY_BUDGET_USD → Anthropic off till Tashkent midnight; then scripted', async () => {
  const at = new Date('2026-10-28T10:00:00Z');
  const gemini = fakeProvider('gemini', { '*': [{ error: 'overloaded' }] });
  const anthropic = fakeProvider('anthropic', { '*': [{ text: 'ok', usage: { input: 100000, output: 10000, cached: 0 } }] });
  const ai = createAi({ db, adapters: { gemini, anthropic }, env: { AI_DAILY_BUDGET_USD: '0.5' }, now: () => at });
  const r = await ai.chat({ role: 'tools', system: 'S', messages: msgs });
  assert.equal(r.model, 'claude-sonnet-5-5');
  near(r.costUsd, 0.3);
  const row = await db.one("SELECT cost_usd::float AS c FROM ai_calls WHERE provider = 'anthropic'");
  near(row.c, 0.3);
  assert.equal(ai.health.skip('claude-sonnet-5-5', 'anthropic'), null, '0.3 < 0.5');
  await ai.chat({ role: 'tools', system: 'S', messages: msgs });
  assert.equal(ai.health.skip('claude-sonnet-5-5', 'anthropic'), 'budget');
  const st = await db.one("SELECT status, cooldown_until FROM ai_provider_state WHERE key = 'anthropic'");
  assert.equal(st.status, 'disabled');
  assert.equal(new Date(st.cooldown_until).toISOString(), '2026-10-28T19:00:00.000Z');
  const r3 = await ai.chat({ role: 'tools', system: 'S', messages: msgs });
  assert.equal(r3.provider, 'scripted');
  assert.equal(anthropic.calls.length, 2);
});

test('demo switches: geminiDisabled skips Gemini (and embeddings), primaryDisabled the first model; state untouched', async () => {
  const settings = createSettings(db);
  const gemini = fakeProvider('gemini', { '*': [{ text: 'ok' }] });
  const ai = createAi({ db, settings, adapters: { gemini, anthropic: null } });
  await settings.set('ai', { geminiDisabled: false, primaryDisabled: true, geminiTier: 'free' });
  assert.equal((await ai.chat({ role: 'tools', system: 'S', messages: msgs })).model, 'gemini-3.6-flash');
  assert.equal((await ai.chat({ role: 'fast', system: 'S', messages: msgs })).model, 'gemini-3.1-flash-lite');
  await settings.set('ai', { geminiDisabled: true, primaryDisabled: false, geminiTier: 'free' });
  const r = await ai.chat({ role: 'tools', system: 'S', messages: msgs });
  assert.equal(r.provider, 'scripted', 'no Claude key → scripted (NFR-REL-03)');
  await assert.rejects(ai.embed({ texts: ['x'] }));
  assert.equal((await db.query("SELECT * FROM ai_provider_state WHERE status <> 'ok'")).length, 0, 'no cooldown or disabled');
  await settings.set('ai', { geminiDisabled: false, primaryDisabled: false, geminiTier: 'free' });
  assert.equal((await ai.chat({ role: 'tools', system: 'S', messages: msgs })).model, 'gemini-3.8-flash');
});
