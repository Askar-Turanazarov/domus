// The price of one request (06 §14.1), $: written to ai_calls as if paid even on the Gemini free tier (§14.1),
// so «what would it cost in life» has an honest answer. Prices — models.js, $ per 1M tokens. Pure.
import { MODELS } from './models.js';

// usage — { input, output, cached, cacheWrite? }: input counts the cached and cache-written tokens too (both adapters).
export function costOf(model, usage) {
  const p = MODELS[model]?.price;
  if (!p || !usage) return 0;
  const cached = usage.cached || 0;
  const write = usage.cacheWrite || 0;
  const fresh = Math.max(0, (usage.input || 0) - cached - write);
  const usd = fresh * p.input + cached * (p.cached ?? p.input) + write * (p.cacheWrite ?? p.input) + (usage.output || 0) * p.output;
  return usd / 1e6;
}
