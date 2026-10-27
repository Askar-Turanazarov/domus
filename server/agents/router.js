// The router (07 §3, D-09): the fast chain turns a message into { lang, agents ≤ 2, tasks, handoff, injection } by a strict
// JSON schema. The short paths of §3.3 skip it; without a model or with a bad answer — the word rules of §3.4.
import { z } from 'zod';
import { prompt } from './prompts.js';
import { byWords, langOf, smalltalkOf } from './keywords.js';
import { isConsent } from './confirm.js';

export const AGENTS = ['apt_finder', 'finance', 'booking', 'kb_consultant', 'smalltalk', 'handoff'];
const LANGS = ['ru', 'uz', 'en'];
const task = z.string().max(300);

export const RouterOut = z.strictObject({
  lang: z.enum(LANGS),
  agents: z.array(z.enum(AGENTS)).max(6),
  tasks: z.strictObject(Object.fromEntries(AGENTS.map(a => [a, task.optional()]))),
  handoff: z.boolean(),
  injection: z.boolean()
});
const SCHEMA = z.toJSONSchema(RouterOut, { target: 'draft-7' });
delete SCHEMA.$schema;

// 07 §11.4: a suggestion button's intent → the agent that serves it (open_3d is a plain link, no agent).
// leave_phone (the site's phone form, 07 §9) is handled by the channel, not an agent.
const BY_INTENT = { show_free: 'apt_finder', calc_installment: 'finance', book: 'booking', book_viewing: 'booking',
  my_bookings: 'booking', call_manager: 'handoff' };

// 07 §3.3 → { kind: 'human' | 'intent' | 'consent' | 'smalltalk', … } | null (null — the router decides).
// consent: the turn tries the only live draft (confirm.textConsent); no single draft → the router after all.
export function shortcut({ text, intent = null, payload = {}, mode = 'bot' }) {
  if (mode === 'human') return { kind: 'human' };
  if (intent) return { kind: 'intent', intent, payload, agent: BY_INTENT[intent] ?? null };
  if (isConsent(text)) return { kind: 'consent' };
  const small = smalltalkOf(text);
  if (small) return { kind: 'smalltalk', agents: ['smalltalk'], template: small };
  return null;
}

// The model's answer → the plan the turn follows: ≤ 2 agents (the rest are «Ещё спросить» hints), only their tasks.
function plan(out, via) {
  let agents = [...new Set(out.agents)];
  if (out.injection) agents = [];
  else if (out.handoff || agents.includes('handoff')) agents = ['handoff'];
  const run = agents.slice(0, 2);
  const tasks = Object.fromEntries(run.filter(a => out.tasks?.[a]).map(a => [a, out.tasks[a]]));
  return { lang: out.lang, agents: run, more: agents.slice(2), tasks, handoff: run[0] === 'handoff',
    injection: !!out.injection, via };
}

function byRules(text, lang, via, error = null) {
  const w = byWords(text);
  const handoff = w.agents.includes('handoff');
  return { lang, agents: handoff ? ['handoff'] : w.agents, more: handoff ? [] : w.more, tasks: {}, handoff, injection: false,
    via, error };
}

// The context the router reads (07 §3.1): the dialog's last 6 messages (already masked, §15.1), the memory, the new message.
function input({ message, history = [], memory = null, conversationLang }) {
  const lines = ['[context]', `dialog_language: ${conversationLang}`];
  if (memory) lines.push(`memory: ${memory}`);
  lines.push('[/context]', '[dialog]', ...history.slice(-6).map(m => `${m.role === 'assistant' ? 'assistant' : 'client'}: ${m.text}`),
    '[/dialog]', '[new_message]', message, '[/new_message]');
  return [{ role: 'user', parts: [{ type: 'text', text: lines.join('\n') }] }];
}

// → { lang, agents, more, tasks, handoff, injection, via: 'model' | 'words', error?, call? }
// call — the model call's facts for agent_runs (provider, model, usage, ms, costUsd).
export async function route(ai, { message, history = [], memory = null, conversationLang = 'ru', turnId = null, deadline = null,
  signal = null, log = console }) {
  const lang = langOf(message, conversationLang);
  if (!ai) return byRules(message, lang, 'words');
  const res = await ai.chat({ role: 'fast', agent: 'router', turnId, system: prompt('router', { common: false }).text,
    messages: input({ message, history, memory, conversationLang }), output: { schema: SCHEMA }, maxOutputTokens: 400,
    deadline, signal });
  const call = { provider: res.provider, model: res.model, usage: res.usage, ms: res.ms, costUsd: res.costUsd, stop: res.stop };
  if (res.provider === 'scripted') return { ...byRules(message, lang, 'words'), call };
  const ok = res.json ? RouterOut.safeParse(res.json) : null;
  if (!ok?.success) {
    log.warn?.('router_invalid');
    return { ...byRules(message, lang, 'words', 'router_invalid'), call };
  }
  const r = plan(ok.data, 'model');
  return { ...r, error: r.injection ? 'injection' : null, call };
}
