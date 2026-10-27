// The sub-agent loop (07 §4–5): steps of the tools chain with this agent's tools; reading calls of a step run in parallel,
// one mutating action per turn (a draft, §8); the figures check of §15.4 before the text goes out; refusal, max_tokens,
// no model and the turn budget answered by code. Counts for agent_runs are summed over the steps.
import { t } from '../i18n/index.js';
import { prompt } from './prompts.js';
import { template } from './scripted.js';
import { knownNumbers, ungrounded, scrub } from './grounding.js';
import { applyCitations } from '../kb/citations.js';

// 07 §4.1 MAX_STEPS and §5: the tools each agent sees.
export const AGENTS = {
  apt_finder: { steps: 3, tools: ['search_apartments', 'get_apartment'] },
  finance: { steps: 4, tools: ['get_apartment', 'calc_installment', 'calc_mortgage', 'compare_finance'] },
  booking: { steps: 3, tools: ['get_apartment', 'book_viewing', 'create_booking', 'my_bookings', 'request_extension'] },
  kb_consultant: { steps: 2, tools: ['search_kb'] }
};
const MAX_OUTPUT = { finance: 1200 };

const SHORTER = 'Answer shorter.';
const CITE = 'Cite sources as [n].';
const SEARCH_FIRST = 'Call search_kb first, then answer from its fragments.';
const notGrounded = xs => `Number ${xs.map(x => x.text).join(', ')} is not in tool results. Use only tool results.`;

const sumUsage = (a, b = {}) => ({ input: a.input + (b.input || 0), output: a.output + (b.output || 0), cached: a.cached + (b.cached || 0) });

// task — the router's words; message — the client's message (masked, §15.1); context — contextBlock (§7.3);
// history — [{ role, parts }] of the last messages (§6.2); toolCtx — the registry's ctx (actor, conversationId, lang…);
// turn — shared by the agents of one turn: { pending: [] } (one action per turn), from (the model to start with, 06 §4 rule 2).
// → { agent, text, ok, error, calls: [{ id, name, args, ok, result, error, pending }], pending, steps, provider, model,
//     fallback, usage, costUsd, ms, firstEventMs }
export async function runAgent({ ai, tools, agent, task = null, message, context, history = [], toolCtx, lang = 'ru',
  onEvent = () => {}, deadline = null, signal = null, turn = { pending: [] } }) {
  const cfg = AGENTS[agent];
  if (!cfg) throw new Error(`no agent ${agent}`);
  const system = prompt(agent).text;
  const schemas = tools.schemas(toolCtx).filter(s => cfg.tools.includes(s.name));
  const ask = task ? `${message}\n\n[task] ${task}` : message;
  const messages = [{ role: 'user', parts: [{ type: 'text', text: context }] }, ...history, { role: 'user', parts: [{ type: 'text', text: ask }] }];
  const run = { agent, text: '', ok: true, error: null, calls: [], pending: [], steps: 0, provider: null, model: null,
    fallback: false, usage: { input: 0, output: 0, cached: 0 }, costUsd: 0, ms: 0, firstEventMs: null };
  const t0 = performance.now();
  let streamed = false;
  const emit = ev => {
    if (ev.type === 'text') {
      streamed = true;
      if (run.firstEventMs === null) run.firstEventMs = Math.round(performance.now() - t0);
      onEvent({ type: 'text', agent, delta: ev.delta });
    } else if (ev.type === 'reset') onEvent({ type: 'reset', agent });
  };
  const reset = () => { if (streamed) { onEvent({ type: 'reset', agent }); streamed = false; } };
  const done = (fields = {}) => Object.assign(run, fields, { ms: Math.round(performance.now() - t0) });

  async function step(msgs) {
    const r = await ai.chat({ role: 'tools', agent, turnId: toolCtx.turnId ?? null, system, messages: [...msgs], tools: schemas,
      maxOutputTokens: MAX_OUTPUT[agent], onEvent: emit, signal, deadline, from: turn.from ?? null });
    run.usage = sumUsage(run.usage, r.usage);
    run.costUsd += r.costUsd || 0;
    if (r.provider !== 'scripted') { run.provider = r.provider; run.model = r.model; run.fallback ||= !!r.fallback; turn.from = r.model; }
    else if (!run.provider) run.provider = 'scripted';
    return r;
  }

  let shorter = false, regrounded = false, cited = false, searched = false;
  for (let i = 1; i <= cfg.steps; i++) {
    run.steps = i;
    const r = await step(messages);
    if (r.provider === 'scripted') {
      reset();
      const error = r.stop === 'turn_timeout' ? 'turn_timeout' : 'unavailable';
      return done({ ok: false, error, text: '' });
    }
    if (r.stop === 'refusal') {
      reset();
      return done({ ok: false, error: 'refusal', text: template('refusal', lang).text });
    }
    let text = r.parts.filter(p => p.type === 'text').map(p => p.text).join('');
    const calls = r.parts.filter(p => p.type === 'tool_call');
    if (r.stop === 'max_tokens' && !shorter && !calls.length) {
      shorter = true;
      reset();
      messages.push({ role: 'assistant', parts: r.parts, native: r.native }, { role: 'user', parts: [{ type: 'text', text: SHORTER }] });
      i--;
      continue;
    }
    if (!calls.length && agent === 'kb_consultant') {
      // 09 §6, 07 §5.4: the answer stands on the fragments found; no answer in the base is said by code, not by the model.
      const found = [...run.calls].reverse().find(c => c.name === 'search_kb' && c.ok)?.result;
      if (!found && !searched) {
        searched = true;
        reset();
        messages.push({ role: 'assistant', parts: r.parts, native: r.native }, { role: 'user', parts: [{ type: 'text', text: SEARCH_FIRST }] });
        i--;
        continue;
      }
      if (!found?.answered) {
        reset();
        const refusal = template('no_kb_answer', lang).text;
        onEvent({ type: 'text', agent, delta: refusal });
        return done({ ok: true, error: 'no_kb_answer', text: refusal, kb: found ?? null });
      }
      const fixed = applyCitations(text, found.chunks);
      if (!fixed.used.length && !cited) {
        cited = true;
        reset();
        messages.push({ role: 'assistant', parts: r.parts, native: r.native }, { role: 'user', parts: [{ type: 'text', text: CITE }] });
        i--;
        continue;
      }
      if (fixed.text !== text) { reset(); onEvent({ type: 'text', agent, delta: fixed.text }); }
      text = fixed.text;
      run.kb = found;
      run.citations = fixed.citations;
      if (!fixed.used.length) run.error = 'no_citations';
    }
    if (!calls.length) {
      const known = knownNumbers({ calls: run.calls, message });
      const miss = ungrounded(text, known);
      if (miss.length && !regrounded) {
        regrounded = true;
        reset();
        messages.push({ role: 'assistant', parts: r.parts, native: r.native }, { role: 'user', parts: [{ type: 'text', text: notGrounded(miss) }] });
        i--;
        continue;
      }
      if (miss.length) {
        reset();
        const fixed = scrub(text, miss, t(lang, 'agent.ungrounded'));
        onEvent({ type: 'text', agent, delta: fixed });
        return done({ ok: true, error: 'ungrounded_number', text: fixed });
      }
      return done({ text, ...(run.error ? { error: run.error } : {}) });
    }
    messages.push({ role: 'assistant', parts: r.parts, native: r.native });
    messages.push({ role: 'tool', parts: await callTools(calls) });
  }
  reset();
  return done({ ok: false, error: 'max_steps', text: template('max_steps', lang).text });

  // §4.1: reading calls in parallel; a mutating one — the first of the turn only, the rest get one_action_per_turn.
  async function callTools(calls) {
    const mutates = c => !!tools.get(c.name)?.mutates;
    const one = async c => {
      if (!cfg.tools.includes(c.name)) return record(c, { ok: false, error: 'unknown_tool' });
      if (mutates(c) && turn.pending.length) return record(c, { ok: false, error: 'one_action_per_turn' });
      if (mutates(c)) turn.pending.push(c.id);
      const res = await tools.run(c.name, c.args, toolCtx);
      if (res.pending) { run.pending.push(res); turn.pending.splice(turn.pending.indexOf(c.id), 1, res.pendingActionId); }
      else if (mutates(c)) turn.pending.splice(turn.pending.indexOf(c.id), 1);
      return record(c, res);
    };
    return calls.every(c => !mutates(c)) ? Promise.all(calls.map(one)) : sequential(calls, one);
  }

  function record(c, res) {
    const result = res.ok ? (res.model ?? res.out ?? null) : { error: res.error, ...(res.message ? { message: res.message } : {}),
      ...(res.fields ? { fields: res.fields } : {}) };
    run.calls.push({ id: c.id, name: c.name, args: c.args, ok: !!res.ok, result: res.ok ? (res.pending ? res.preview : res.out) : result,
      error: res.ok ? null : res.error, pending: res.pending ? res : null });
    return { type: 'tool_result', id: c.id, name: c.name, result, isError: !res.ok };
  }
}

async function sequential(xs, fn) {
  const out = [];
  for (const x of xs) out.push(await fn(x));
  return out;
}

// 07 §5.5: smalltalk is a template, no model: hello (what I can do + three buttons), thanks, «are you a bot?».
export function smalltalk(kind, lang) {
  return { agent: 'smalltalk', text: template(kind === 'bot' ? 'bot' : kind === 'thanks' ? 'thanks' : 'hello', lang).text, ok: true,
    error: null, calls: [], pending: [], steps: 0, provider: 'scripted', model: null, fallback: false,
    usage: { input: 0, output: 0, cached: 0 }, costUsd: 0, ms: 0, firstEventMs: 0 };
}

