// Answers without any model (06 §16, NFR-REL-03): the menu and the templates of 07 §4.1, §10, §15.3. The buttons carry
// an intent of 07 §11.4, so a press runs code, not a model. Texts — server/i18n. Pure.
import { t } from '../i18n/index.js';

const button = (lang, key, intent, payload = {}) => ({ label: t(lang, key), intent, payload });

// 06 §16.1: «what I can do» — free apartments, installments, a manager (07 §9: and a phone form on the site).
export function menu(lang, { channel = 'web' } = {}) {
  const suggestions = [
    button(lang, 'agent.menu.show_free', 'show_free'),
    button(lang, 'agent.menu.calc_installment', 'calc_installment'),
    button(lang, 'agent.menu.call_manager', 'call_manager')
  ];
  if (channel === 'web') suggestions.push(button(lang, 'agent.menu.leave_phone', 'leave_phone'));
  return { text: t(lang, 'agent.menu'), suggestions, provider: 'scripted' };
}

// 07 §12, last row: after a refusal or an error.
export const fallbackSuggestions = lang => [
  button(lang, 'agent.suggest.find', 'show_free'),
  button(lang, 'agent.menu.call_manager', 'call_manager')
];

const WITH_FALLBACK = new Set(['refusal', 'injection', 'max_steps', 'turn_timeout', 'no_kb_answer']);

// name — refusal, injection, max_steps, turn_timeout, rate_limited, long_message, handoff, extension_requested,
// no_kb_answer, hello, thanks, bot.
export function template(name, lang) {
  const text = t(lang, `agent.${name}`);
  if (text == null) throw new Error(`no template agent.${name}`);
  return { text, suggestions: WITH_FALLBACK.has(name) ? fallbackSuggestions(lang) : [] };
}

// 07 §4.3: the status line before an agent's first step.
export const statusText = (agent, lang) => t(lang, `agent.status.${agent}`) ?? t(lang, 'agent.status.smalltalk');
