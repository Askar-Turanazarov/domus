// The one entry of the agents to the models (06 §2): chat() — one model step along the role's chain, embed().
// Which model answers, how the request is translated and what an error means is decided here, never in an agent.
import { MODELS, EMBED_MODEL, DEFAULT_MAX_OUTPUT, hasKey, KEY_VAR, timeouts } from './models.js';
import { candidates } from './chains.js';
import { AiError } from './errors.js';
import { createGemini } from './gemini.js';
import { createAnthropic } from './anthropic.js';

const toolCallsIn = messages => messages.reduce((n, m) => n + m.parts.filter(p => p.type === 'tool_call').length, 0);

// A step's AbortSignal: the caller's signal, no first byte in firstByteMs, no full answer in totalMs.
function deadlines(outer, { firstByteMs, totalMs }) {
  const ac = new AbortController();
  const stop = cls => { if (!ac.signal.aborted) ac.abort(new AiError(cls)); };
  const first = setTimeout(() => stop('timeout'), firstByteMs);
  const total = setTimeout(() => stop('timeout'), totalMs);
  const onOuter = () => { if (!ac.signal.aborted) ac.abort(outer.reason ?? new Error('aborted')); };
  outer?.addEventListener('abort', onOuter, { once: true });
  if (outer?.aborted) onOuter();
  return {
    signal: ac.signal,
    tick: () => clearTimeout(first),
    done: () => { clearTimeout(first); clearTimeout(total); outer?.removeEventListener('abort', onOuter); }
  };
}

// env — keys; adapters — { gemini, anthropic } (tests pass fakes; production builds the SDK ones from the keys).
export function createAi({ env = process.env, adapters = null } = {}) {
  const ad = adapters || {
    gemini: hasKey('gemini', env) ? createGemini({ apiKey: env[KEY_VAR.gemini] }) : null,
    anthropic: hasKey('anthropic', env) ? createAnthropic({ apiKey: env[KEY_VAR.anthropic] }) : null
  };

  // A model is skipped without a request when its provider has no key (06 §4 rule 1).
  const skip = (model, provider) => (ad[provider] ? null : 'no_key');

  async function chat({ role, agent = null, turnId = null, system, messages, tools = [], output = null,
    maxOutputTokens = DEFAULT_MAX_OUTPUT, onEvent = () => {}, signal = null, from = null }) {
    const t0 = performance.now();
    let firstEventMs = null;
    const emit = ev => { if (firstEventMs === null && ev.type === 'text') firstEventMs = Math.round(performance.now() - t0); onEvent(ev); };
    const list = candidates(role, { from, skip });
    const first = list.find(c => !c.skipped);
    for (const c of list) {
      if (c.skipped) continue;
      const lim = timeouts(role, env);
      const d = deadlines(signal, lim);
      try {
        const r = await ad[c.provider].call({ model: c.model, cfg: MODELS[c.model], role, system, messages, tools, output, maxOutputTokens },
          { onEvent: emit, signal: d.signal, tick: d.tick, firstId: toolCallsIn(messages) + 1 });
        return finish(r, c, { first, t0, firstEventMs, output });
      } catch (e) {
        if (signal?.aborted) throw e;
        if (!(e instanceof AiError)) throw e;
      } finally { d.done(); }
    }
    return { parts: [], stop: 'unavailable', provider: 'scripted', model: null, fallback: true,
      usage: { input: 0, output: 0, cached: 0 }, costUsd: 0, ms: Math.round(performance.now() - t0), firstEventMs, native: null };
  }

  function finish(r, c, { t0, firstEventMs, output }) {
    const res = { ...r, provider: c.provider, model: c.model, fallback: c.index > 0, costUsd: 0,
      ms: Math.round(performance.now() - t0), firstEventMs };
    if (output && r.stop === 'end') {
      const text = r.parts.filter(p => p.type === 'text').map(p => p.text).join('');
      try { res.json = JSON.parse(text); } catch { res.json = null; }
    }
    return res;
  }

  // 06 §13: vectors for texts; without Gemini → AiError (search falls back to words, 09 §5.4).
  async function embed({ texts, taskType = 'RETRIEVAL_QUERY', signal = null }) {
    if (!ad.gemini) throw new AiError('auth', { reason: 'no_key' });
    const cfg = MODELS[EMBED_MODEL];
    return ad.gemini.embed({ model: EMBED_MODEL, texts, taskType, dims: cfg.dims }, { signal });
  }

  return { chat, embed, adapters: ad };
}
