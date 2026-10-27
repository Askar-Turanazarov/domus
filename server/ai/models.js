// The models (06 §3), free-tier limits (§7), timeouts (§8.5) and prices (§14). Every number of the AI layer lives here:
// a model renamed by Google or a new price is a change of this file only. Checked on ai.google.dev 27.10.2026: ids,
// prices ($ per 1M; 3.8/3.6 Flash double from 01.01.2027), thinking levels. Free-tier rpm/rpd are shown only in AI Studio
// [проверить с ключом]. thinkingLevel — each model's lowest (author): 3.8 Flash has no 'minimal' (low/medium/high).
export const MODELS = Object.freeze({
  'gemini-3.8-flash':      { provider: 'gemini', role: 'tools', price: { input: 0.75, output: 3.75, cached: 0.075 }, rpm: 15, rpd: 1500, thinkingLevel: 'low' },
  'gemini-3.6-flash':      { provider: 'gemini', role: 'tools', price: { input: 0.75, output: 3.75, cached: 0.075 }, rpm: 15, rpd: 1500, thinkingLevel: 'minimal' },
  'claude-sonnet-5-5':     { provider: 'anthropic', role: 'tools', price: { input: 2, output: 10, cached: 0.2, cacheWrite: 2.5 }, thinking: 'between_tools' },
  'gemini-3.5-flash-lite': { provider: 'gemini', role: 'fast', price: { input: 0.3, output: 2.5, cached: 0.03 }, rpm: 15, rpd: 1500, thinkingLevel: 'minimal' },
  'gemini-3.1-flash-lite': { provider: 'gemini', role: 'fast', price: { input: 0.25, output: 1.5, cached: 0.025 }, rpm: 15, rpd: 1500, thinkingLevel: 'minimal' },
  'claude-haiku-5-5':      { provider: 'anthropic', role: 'fast', price: { input: 0.1, output: 0.5, cached: 0.01, cacheWrite: 0.125 }, thinking: 'disabled' },
  'gemini-embedding-001':  { provider: 'gemini', role: 'embed', price: { input: 0.15, output: 0, cached: 0 }, rpm: 100, rpd: 1000, dims: 768 }
});

// 06 §4 (D-01): the chain of each role, first to last. Empty → scripted answers (§16). Reasoning models (Gemini 4
// Argon, 3.x Pro) are left out on purpose: their first byte does not fit the timeouts of §8.5.
export const CHAINS = Object.freeze({
  tools: ['gemini-3.8-flash', 'gemini-3.6-flash', 'claude-sonnet-5-5'],
  fast: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'claude-haiku-5-5']
});

export const EMBED_MODEL = 'gemini-embedding-001';

// 06 §8.5, ms. AI_TIMEOUTS (JSON) overrides them while debugging.
export const TIMEOUTS = Object.freeze({ fast: { firstByteMs: 2500, totalMs: 6000 }, tools: { firstByteMs: 5000, totalMs: 20000 } });

export function timeouts(role, env = process.env) {
  let over = {};
  try { over = env.AI_TIMEOUTS ? JSON.parse(env.AI_TIMEOUTS)[role] || {} : {}; } catch { /* bad JSON: defaults */ }
  return { ...TIMEOUTS[role], ...over };
}

// 06 §2.1: 1024 tokens by default — chat answers are short (07 §7).
export const DEFAULT_MAX_OUTPUT = 1024;

// 06 §14.4: the guard on paid Anthropic spending per Tashkent day, $.
export const dailyBudgetUsd = (env = process.env) => {
  const n = Number(env.AI_DAILY_BUDGET_USD);
  return Number.isFinite(n) && n > 0 ? n : 5;
};

export const KEY_VAR = { gemini: 'GEMINI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' };
export const hasKey = (provider, env = process.env) => Boolean(env[KEY_VAR[provider]]);
