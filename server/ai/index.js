// The one entry of the agents to the models (06 §2): chat() — one model step along the role's chain, embed().
// Which model answers, how the request is translated and what an error means is decided here, never in an agent.
// A failing model is passed over silently (§8, §10): the user sees a status, not an error, and never waits for a retry.
import { MODELS, EMBED_MODEL, DEFAULT_MAX_OUTPUT, hasKey, KEY_VAR, timeouts } from './models.js';
import { candidates } from './chains.js';
import { AiError } from './errors.js';
import { createGemini } from './gemini.js';
import { createAnthropic } from './anthropic.js';
import { createHealth } from './health.js';
import { createQuota } from './quota.js';
import { now as clockNow } from '../core/clock.js';

const toolCallsIn = messages => messages.reduce((n, m) => n + m.parts.filter(p => p.type === 'tool_call').length, 0);
const ZERO = Object.freeze({ input: 0, output: 0, cached: 0 });

// A step's AbortSignal: the caller's signal, no first byte in firstByteMs, no full answer in totalMs.
function deadlines(outer, { firstByteMs, totalMs }) {
  const ac = new AbortController();
  const stop = () => { if (!ac.signal.aborted) ac.abort(new AiError('timeout')); };
  const first = setTimeout(stop, firstByteMs);
  const total = setTimeout(stop, totalMs);
  const onOuter = () => { if (!ac.signal.aborted) ac.abort(outer.reason ?? new Error('aborted')); };
  outer?.addEventListener('abort', onOuter, { once: true });
  if (outer?.aborted) onOuter();
  const d = {
    signal: ac.signal,
    firstByte: false,
    tick: () => { if (!d.firstByte) { d.firstByte = true; clearTimeout(first); } },
    done: () => { clearTimeout(first); clearTimeout(total); outer?.removeEventListener('abort', onOuter); }
  };
  return d;
}

// db — the base (ai_calls, ai_provider_state; null in scripts); env — keys; adapters — { gemini, anthropic }
// (tests pass fakes; production builds the SDK ones from the keys); now — the clock.
export function createAi({ db = null, env = process.env, adapters = null, now = clockNow, health = null, log = console } = {}) {
  const ad = adapters || {
    gemini: hasKey('gemini', env) ? createGemini({ apiKey: env[KEY_VAR.gemini] }) : null,
    anthropic: hasKey('anthropic', env) ? createAnthropic({ apiKey: env[KEY_VAR.anthropic] }) : null
  };
  const hl = health || createHealth({ db, now });
  const quota = createQuota({ db, now });

  // 06 §4 rule 1: no key, cooldown or disabled → skipped without a request.
  const skip = (model, provider) => (ad[provider] ? hl.skip(model, provider) : 'no_key');

  // One row per request to a model, ok or not (§8.1, §14): numbers and classes only — never a prompt or an answer.
  async function record(row) {
    if (!db) return;
    try {
      await db.query(`INSERT INTO ai_calls (at, turn_id, agent, provider, model, kind, ok, error_class, input_tokens, output_tokens, cached_tokens, cost_usd, ms)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [now(), row.turnId, row.agent, row.provider, row.model, row.kind, row.ok, row.cls ?? null,
        row.usage.input, row.usage.output, row.usage.cached, row.costUsd ?? 0, row.ms]);
    } catch { /* the journal must not break the answer */ }
  }

  // deadline — epoch ms of the whole turn's budget (07 §10); a backup model gets what is left of it, but no less
  // than its role's firstByteMs (§8.5). from — the model this agent stopped at in the turn (§4 rule 2).
  async function chat({ role, agent = null, turnId = null, system, messages, tools = [], output = null,
    maxOutputTokens = DEFAULT_MAX_OUTPUT, onEvent = () => {}, signal = null, from = null, deadline = null }) {
    const t0 = performance.now();
    let firstEventMs = null;
    await hl.refresh();
    const list = candidates(role, { from, skip });
    let badProvider = null;
    let lastError = null;
    for (const c of list) {
      // re-checked: an auth or billing of the previous model turns off its whole provider
      if (c.skipped || skip(c.model, c.provider)) continue;
      // bad_request is our bug: one jump to a model of the other provider, not along the same one (§8.1).
      if (badProvider && c.provider === badProvider) continue;
      const g = await quota.guard(c.model);
      if (g) { await hl.cooldown(c.provider, c.model, g.until.getTime(), g.reason); continue; }
      for (let attempt = 0; attempt < 2; attempt++) {
        const lim = { ...timeouts(role, env) };
        if (deadline != null) {
          const left = deadline - now().getTime();
          if (left <= 0) return empty('turn_timeout', t0, firstEventMs);
          lim.totalMs = Math.min(lim.totalMs, Math.max(left, lim.firstByteMs));
        }
        const d = deadlines(signal, lim);
        let streamed = false;
        const emit = ev => {
          if (ev.type === 'text') { streamed = true; if (firstEventMs === null) firstEventMs = Math.round(performance.now() - t0); }
          onEvent(ev);
        };
        const s0 = performance.now();
        try {
          const r = await ad[c.provider].call({ model: c.model, cfg: MODELS[c.model], role, system, messages, tools, output, maxOutputTokens },
            { onEvent: emit, signal: d.signal, tick: d.tick, firstId: toolCallsIn(messages) + 1 });
          const ms = Math.round(performance.now() - s0);
          await record({ turnId, agent, provider: c.provider, model: c.model, kind: 'chat', ok: true, usage: r.usage, ms });
          await hl.ok(c.provider, c.model);
          return finish(r, c, { t0, firstEventMs, output });
        } catch (e0) {
          if (signal?.aborted) throw e0;
          const e = e0 instanceof AiError ? e0 : new AiError('server');
          if (!(e0 instanceof AiError)) log.error?.('ai adapter failed:', e0?.name || 'error');
          if (e.cls === 'bad_request') log.error?.(`ai bad_request on ${c.model} (HTTP ${e.status})`);
          lastError = e.cls;
          await record({ turnId, agent, provider: c.provider, model: c.model, kind: 'chat', ok: false, cls: e.cls, usage: ZERO,
            ms: Math.round(performance.now() - s0) });
          await hl.fail(c.provider, c.model, e);
          // Mid-text: the chat drops the draft and the next model writes the answer anew (§10).
          if (streamed) onEvent({ type: 'reset' });
          // One immediate retry of the same model: a drop before the first byte, a broken function call (§4 rule 3).
          if (attempt === 0 && ((e.cls === 'network' && !d.firstByte) || e.cls === 'malformed')) continue;
          if (e.cls === 'bad_request') badProvider = c.provider;
          break;
        } finally { d.done(); }
      }
    }
    return empty('unavailable', t0, firstEventMs, lastError);
  }

  // No model answered: the agent answers by script (§16); turn_timeout — the turn's budget is spent (§8.5).
  function empty(stop, t0, firstEventMs, error = null) {
    return { parts: [], stop, error, provider: 'scripted', model: null, fallback: true, usage: { ...ZERO }, costUsd: 0,
      ms: Math.round(performance.now() - t0), firstEventMs, native: null };
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
    const model = EMBED_MODEL;
    if (!ad.gemini || hl.skip(model, 'gemini')) throw new AiError('auth', { reason: 'unavailable' });
    const s0 = performance.now();
    try {
      const r = await ad.gemini.embed({ model, texts, taskType, dims: MODELS[model].dims }, { signal });
      await record({ provider: 'gemini', model, kind: 'embed', ok: true, usage: r.usage, ms: Math.round(performance.now() - s0) });
      return r;
    } catch (e0) {
      const e = e0 instanceof AiError ? e0 : new AiError('server');
      await record({ provider: 'gemini', model, kind: 'embed', ok: false, cls: e.cls, usage: ZERO, ms: Math.round(performance.now() - s0) });
      await hl.fail('gemini', model, e);
      throw e;
    }
  }

  return { chat, embed, adapters: ad, health: hl, quota };
}
