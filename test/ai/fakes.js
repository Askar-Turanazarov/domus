// Fake model providers (06 §17): no keys, no network. A script is a list of steps, each either an answer
// { text?, calls?: [{name, args}], stop?, usage? } or an error { error: 'rate_minute' | …, afterText? }.
// Every call is recorded with the request it got, so tests check what reached the «model».
import { AiError } from '../../server/ai/errors.js';

export function fakeProvider(provider, script = {}) {
  // script: { [model]: [step, step, …] } or { '*': [...] } — steps are taken in order per model; the last repeats.
  const used = {};
  const calls = [];
  const next = model => {
    const list = script[model] || script['*'] || [{ text: 'ok' }];
    const i = used[model] = (used[model] ?? -1) + 1;
    return list[Math.min(i, list.length - 1)];
  };
  return {
    provider,
    calls,
    async call(req, { onEvent = () => {}, tick = () => {}, firstId = 1, signal } = {}) {
      calls.push({ model: req.model, req });
      const step = next(req.model);
      const s = typeof step === 'function' ? step(req) : step;
      if (s.wait) await new Promise((res, rej) => {
        const t = setTimeout(res, s.wait);
        signal?.addEventListener('abort', () => { clearTimeout(t); rej(signal.reason); }, { once: true });
      });
      tick();
      if (s.afterText) onEvent({ type: 'text', delta: s.afterText });
      if (s.error) throw new AiError(s.error, { status: s.status ?? null, retryMs: s.retryMs ?? null });
      const parts = [];
      if (s.text) { parts.push({ type: 'text', text: s.text }); if (!req.output) onEvent({ type: 'text', delta: s.text }); }
      let n = firstId;
      for (const c of s.calls || []) parts.push({ type: 'tool_call', id: `tc_${n++}`, name: c.name, args: c.args || {} });
      return { parts, stop: s.stop || (s.calls?.length ? 'tool_calls' : 'end'),
        usage: s.usage || { input: 1000, output: 50, cached: 0 }, native: { provider, model: req.model, parts: ['raw'] } };
    },
    async embed({ texts }) { return { vectors: texts.map(() => [1, 0]), usage: { input: 0, output: 0, cached: 0 } }; }
  };
}

export const userMsg = text => ({ role: 'user', parts: [{ type: 'text', text }] });
