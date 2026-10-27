// The person's side of a draft (07 §8, D-10): the confirmation card is built by code from the preview (never by the model,
// so the terms are shown word for word, 03 §4.4); «Да» by button or by text; «Изменить», «Отмена», «Повторить».
// Channel-neutral: the site draws the block, the bot turns buttons into callback_data pa:<id>:y|e|n|r (10 §4.4).
import { t } from '../i18n/index.js';
import { money, areaText, tashkent } from '../notify/format.js';
import { aptUrl } from '../tools/common.js';
import { fallbackSuggestions } from './scripted.js';

// 07 §3.3: the consent words, the whole message and nothing else (case, spaces, punctuation and emoji ignored).
const YES = new Set(['да', 'ha', 'xa', 'ҳа', 'yes', 'подтверждаю']);
export const isConsent = text => YES.has(String(text ?? '').toLowerCase().replace(/[\s.,!?…👍✅]+/gu, ' ').trim());

const ANSWERS = { y: 'yes', e: 'edit', n: 'cancel', r: 'retry' };
export const callbackData = (id, a) => `pa:${id}:${a}`;
// 'pa:<uuid>:y' → { pendingActionId, answer } | null
export function parseCallback(data) {
  const m = /^pa:([0-9a-f-]{36}):([yenr])$/.exec(String(data ?? ''));
  return m ? { pendingActionId: m[1], answer: ANSWERS[m[2]] } : null;
}

const button = (id, a, label) => ({ label, action: ANSWERS[a], data: callbackData(id, a) });
const link = (label, url) => ({ label, url });
const intent = (label, name, payload = {}) => ({ label, intent: name, payload });

// 07 §8.2 → { type: 'confirm', data: { pendingActionId, tool, title, lines, buttons } }
export function confirmCard({ pendingActionId: id, tool, preview: p }, lang, env = process.env) {
  const k = key => `confirm.${tool}.${key}`;
  let lines;
  if (tool === 'create_booking') {
    lines = [
      t(lang, k('apt'), { rooms: p.rooms, area: areaText(p.area, lang), floor: p.floor }),
      t(lang, k('price'), { price: money(p.price) }),
      t(lang, k('deposit'), { deposit: money(p.deposit) }),
      t(lang, k('hold'), { min: p.holdMinutes }),
      t(lang, k('refund'), { url: `${env.PUBLIC_URL ?? ''}/legal/offer?lang=${lang}` })
    ];
  } else {
    lines = [t(lang, k('when'), { when: p.local })];
  }
  return { type: 'confirm', data: { pendingActionId: id, tool, title: t(lang, k('title'), { no: p.apartmentNo }), lines,
    buttons: [button(id, 'y', t(lang, k('yes'))), button(id, 'e', t(lang, 'confirm.btn.edit')), button(id, 'n', t(lang, 'confirm.btn.cancel'))] } };
}

// After «Да»: the text and the buttons of 07 §8.3 step 4 / §12 «booking (готово)».
export function doneReply(tool, out, lang, env = process.env) {
  if (tool === 'create_booking') {
    return { text: t(lang, 'confirm.done.create_booking', { no: out.apartmentNo, time: tashkent(out.holdUntil, lang).slice(-5), link: out.link }),
      suggestions: [link(t(lang, 'tpl.btn.pay'), out.link), link(t(lang, 'tpl.btn.open_3d'), aptUrl(out.apartmentNo, lang, env)),
        intent(t(lang, 'confirm.btn.my_bookings'), 'my_bookings')] };
  }
  return { text: t(lang, 'confirm.done.book_viewing', { no: out.apartmentNo, when: out.local }),
    suggestions: [link(t(lang, 'tpl.btn.open_3d'), aptUrl(out.apartmentNo, lang, env)), intent(t(lang, 'confirm.btn.my_bookings'), 'my_bookings')] };
}

// One answer to a draft → { status, text, blocks, suggestions, result? }. The site, the bot and the text «да» all come here.
// answer — yes | edit | cancel | retry; ctx — the registry's (actor, conversationId, lang, contactPhone…).
export async function answerDraft(tools, { pendingActionId, answer }, ctx, env = process.env) {
  const lang = ctx.lang ?? 'ru';
  if (answer === 'edit' || answer === 'cancel') {
    const r = await tools.decline(pendingActionId, ctx);
    if (!r.ok) return problem(r, pendingActionId, lang);
    return answer === 'edit'
      ? { status: 'cancelled', text: t(lang, 'confirm.edit'), blocks: [], suggestions: [] }
      : { status: 'cancelled', text: t(lang, `confirm.${r.tool}.cancelled`), blocks: [], suggestions: [] };
  }
  if (answer === 'retry') {
    const r = await tools.renew(pendingActionId, ctx);
    if (!r.ok) return problem(r, pendingActionId, lang);
    return { status: 'pending', text: t(lang, 'confirm.check'), blocks: [confirmCard(r, lang, env)], suggestions: [], pendingActionId: r.pendingActionId };
  }
  const r = await tools.confirm(pendingActionId, ctx);
  if (r.ok) return { status: 'executed', ...doneReply(r.tool, r.out, lang, env), blocks: [], result: { type: r.tool, data: r.out } };
  return problem(r, pendingActionId, lang);
}

function problem(r, id, lang) {
  if (r.error === 'confirm_expired') {
    return { status: 'expired', error: r.error, text: t(lang, 'confirm.expired'), blocks: [],
      suggestions: [{ ...button(id, 'r', t(lang, 'confirm.btn.retry')) }] };
  }
  if (r.error === 'confirm_used') {
    return { status: 'executed', error: r.error, text: r.message, blocks: [], suggestions: [], result: r.result ?? null };
  }
  if (r.status === 'failed') {
    return { status: 'failed', error: r.error, text: r.message, blocks: [],
      suggestions: [intent(t(lang, 'confirm.btn.similar'), 'show_free', {}), ...fallbackSuggestions(lang).slice(1)] };
  }
  return { status: 'error', error: r.error, text: r.message, blocks: [], suggestions: [] };
}

// 07 §3.3 / §8.3: the text «да» with exactly one live draft in the dialog → that draft is executed; otherwise null —
// the message goes to the ordinary turn and the drafts stay.
export async function textConsent(tools, text, ctx, env = process.env) {
  if (!ctx.conversationId || !isConsent(text)) return null;
  const live = await tools.pendingOf(ctx.conversationId, ctx.now);
  if (live.length !== 1) return null;
  return answerDraft(tools, { pendingActionId: live[0].id, answer: 'yes' }, ctx, env);
}
