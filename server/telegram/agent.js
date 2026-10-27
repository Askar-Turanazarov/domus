// The dialogue with the agent in Telegram (10 §4.3–4.4, §5): free text and menu buttons → agents.runTurn (07 §11) with
// channel = 'telegram'; the stream of events → the draft of the message (stream.js); the final answer → messages with the
// blocks (cards, table, confirmation card) and the buttons; the buttons pa:, sg:, fb: (and the short sgi: of scripted answers).
import { randomInt } from 'node:crypto';
import { InlineKeyboard } from 'grammy';
import { now } from '../core/clock.js';
import { t } from '../i18n/index.js';
import { answerDraft, parseCallback } from '../agents/confirm.js';
import { areaText, money, esc } from '../notify/format.js';
import { LIMIT, splitText, tableHtml } from './format.js';
import { createReplyStream } from './stream.js';

const DAY = 24 * 3600e3;
// 10 §4.2: the menu buttons that are a ready task of the agent (07 §11.4: served by code, no model).
export const MENU_INTENTS = { pick: 'show_free', bookings: 'my_bookings', manager: 'call_manager' };
// sgi:<intent>[:<n>] — a button of a scripted answer (it has no stored message, so no `sg:`): the intent and, if any, the apartment.
const SHORT = /^sgi:([a-z_]{1,24})(?::(\d{1,6}))?$/;
const PAYLOAD_KEY = { calc_installment: 'no', open_3d: 'no', book: 'apartmentNo' };

// deps — { db, turns, tools, env, core, log }; core — { onCommit, render } of the core calls (they reach confirmations).
export function createTelegramAgent({ db, turns, tools, env = process.env, core = {}, log = console }) {
  const base = String(env.PUBLIC_URL ?? '').replace(/\/$/, '');
  const actorOf = client => ({ type: 'client', id: client.id, role: 'client', channel: 'telegram' });

  // 10 §4.3: the last Telegram dialogue of the client if its last message is not older than 24 h, else a new one (the memory and the
  // summary are carried over). The confirmed phone is put into the memory so the booking tool finds the contact.
  async function conversationOf(client) {
    const at = now();
    const last = await db.one(`SELECT * FROM conversations WHERE client_id = $1 AND kind = 'client' AND channel = 'telegram'
      ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT 1`, [client.id]);
    const live = last && at.getTime() - new Date(last.last_message_at ?? last.created_at).getTime() < DAY;
    const state = { ...(last?.state ?? {}) };
    if (client.phone_verified && client.phone) { state.contactPhone = client.phone; state.contactPhoneVerified = true; }
    if (live) {
      await db.query('UPDATE conversations SET lang = $2, state = $3 WHERE id = $1', [last.id, client.lang, JSON.stringify(state)]);
      return { ...last, lang: client.lang, state };
    }
    return db.one(`INSERT INTO conversations (kind, client_id, channel, lang, state, summary, created_at, updated_at)
      VALUES ('client', $1, 'telegram', $2, $3, $4, $5, $5) RETURNING *`, [client.id, client.lang, JSON.stringify(state), last?.summary ?? null, at]);
  }

  // ---- the buttons under a message (10 §4.4: callback_data ≤ 64 bytes) ----
  const siteUrl = (url, lang) => {
    if (/^\/(?![/\\])/.test(url)) return base ? base + url : null;
    try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; }
  };
  function suggestionRows(kb, list, lang, messageId) {
    (Array.isArray(list) ? list : []).forEach((s, i) => {
      if (s.url) { const u = siteUrl(s.url, lang); if (u) kb.url(s.label, u).row(); return; }
      if (s.data) { kb.text(s.label, s.data).row(); return; }                       // «Повторить» of an expired draft
      if (!s.intent) return;
      if (messageId) { kb.text(s.label, `sg:${messageId}:${i}`).row(); return; }
      const key = PAYLOAD_KEY[s.intent];
      const keys = Object.keys(s.payload ?? {});
      if (keys.length && !(keys.length === 1 && keys[0] === key && Number.isInteger(s.payload[key]))) return;   // too big for callback_data
      kb.text(s.label, `sgi:${s.intent}${keys.length ? `:${s.payload[key]}` : ''}`).row();
    });
    return kb;
  }

  // ---- the final answer → messages: [{ html, kb? }] ----
  function messagesOf({ text, blocks = [], suggestions = [], messageId = null }, lang) {
    const out = [];
    const cites = blocks.find(b => b.type === 'citations')?.data?.items ?? [];           // 09 §6: «Источники: [1] …; [2] …» under the answer
    const sources = cites.length ? `\n\n${t(lang, 'tg.sources')}: ${cites.map(c => `[${c.n}] ${c.heading}`).join('; ')}` : '';
    for (const html of splitText(text + sources, LIMIT, { base })) out.push({ html });
    for (const b of blocks) {
      const d = b.data ?? {};
      if (b.type === 'apartments') {
        for (const a of (d.items ?? []).slice(0, 3)) {
          const kb = new InlineKeyboard();
          const u = siteUrl(`/${lang}#apt=${a.no}`, lang);
          if (u) kb.url(t(lang, 'tpl.btn.open_3d'), u).row();
          kb.text(t(lang, 'agent.sg.installment', { no: a.no }), `sgi:calc_installment:${a.no}`).row();
          if (a.status === 'free') kb.text(t(lang, 'agent.sg.book', { no: a.no }), `sgi:book:${a.no}`).row();
          out.push({ html: esc(t(lang, 'tg.apt_card', { no: a.no, rooms: a.rooms, area: areaText(a.area, lang), floor: a.floor,
            price: money(a.price), status: t(lang, `tg.apt_status.${a.status}`) })), kb });
        }
      } else if (b.type === 'table') {
        const tb = tableHtml(d, t, lang);
        out.push({ html: tb.html + (tb.more ? `\n${esc(t(lang, 'tg.table_more'))}` : '') });
      } else if (b.type === 'confirm') {
        const kb = new InlineKeyboard();
        const [yes, ...rest] = d.buttons ?? [];
        if (yes) kb.text(yes.label, yes.data).row();
        for (const x of rest) kb.text(x.label, x.data);
        out.push({ html: [`<b>${esc(d.title)}</b>`, ...(d.lines ?? []).map(l => `• ${esc(l)}`)].join('\n'), kb });
      }
    }
    // the buttons-hints go under the last message (10 §5.2); a 👍/👎 row only under a stored answer
    const rows = (out.at(-1)?.kb) ?? new InlineKeyboard();
    if (messageId && cites.length) {
      for (const c of cites.slice(0, 4)) rows.text(t(lang, 'tg.src_btn', { n: c.n }), `src:${messageId}:${c.n}`);
      rows.row();
    }
    suggestionRows(rows, suggestions, lang, messageId);
    if (messageId && out.length && !out.some(m => m.kb?.inline_keyboard?.some(r => r.some(b => b.callback_data?.startsWith('pa:'))))) {
      rows.text('👍', `fb:${messageId}:1`).text('👎', `fb:${messageId}:-1`);
    }
    if (out.length) { const last = out.at(-1); if (rows.inline_keyboard.some(r => r.length)) last.kb = rows; }
    return out;
  }

  async function deliver(ctx, answer, lang) {
    const list = messagesOf(answer, lang);
    let lastId = null;
    for (const m of list) {
      const rows = (m.kb?.inline_keyboard ?? []).filter(r => r.length);          // grammy leaves an empty row after the last .row()
      const sent = await ctx.api.sendMessage(ctx.chat.id, m.html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true },
        ...(rows.length ? { reply_markup: new InlineKeyboard(rows) } : {}) });
      lastId = sent?.message_id ?? lastId;
    }
    if (answer.messageId && lastId) await db.query('UPDATE messages SET tg_message_id = $2 WHERE id = $1', [answer.messageId, lastId]).catch(() => {});
  }

  // One turn: the input is { text } or { intent, payload }. → nothing; the answer goes to the chat by itself.
  async function run(ctx, client, input) {
    const conv = await conversationOf(client);
    const lang = conv.lang;
    const stream = createReplyStream({ api: ctx.api, chatId: ctx.chat.id, draftId: randomInt(1, 2 ** 31 - 1), resetText: t(lang, 'tg.reset'), log });
    let acc = { text: '', blocks: [], suggestions: [] };
    let chain = Promise.resolve();
    const sink = ev => {
      if (ev.type === 'block') acc.blocks.push(ev.data);
      else if (ev.type === 'suggestions') acc.suggestions = ev.data ?? [];
      else if (ev.type === 'done') {
        const answer = { ...acc, messageId: ev.data?.messageId ?? null };
        acc = { text: '', blocks: [], suggestions: [] };
        chain = chain.then(() => deliver(ctx, answer, lang)).catch(e => log.error?.('telegram deliver failed:', e?.error_code ?? e?.name));
      } else {
        if (ev.type === 'text') acc.text += ev.delta ?? '';
        else if (ev.type === 'reset') acc.text = '';
        stream.event(ev);
      }
    };
    try {
      await turns.runTurn({ conversationId: conv.id, text: input.text ?? '', intent: input.intent ?? null, payload: input.payload ?? {},
        actor: actorOf(client), channel: 'telegram', sink });
      await chain;
    } catch (e) {
      log.error?.('telegram turn failed:', e?.name);
      await chain;
      await ctx.api.sendMessage(ctx.chat.id, t(lang, 'err.ai_unavailable')).catch(() => {});
    } finally {
      await stream.stop();
    }
  }

  // ---- the buttons ----
  async function foreign(ctx, lang = 'ru') {
    await ctx.answerCallbackQuery({ text: t(lang, 'tg.not_for_you'), show_alert: true });
  }

  // pa:<uuid>:y|e|n|r — «Да» / «Изменить» / «Отмена» / «Повторить» on the confirmation card (07 §8).
  async function onDraft(ctx, client) {
    const p = parseCallback(ctx.match[0]);
    const row = p && await db.one('SELECT id, client_id, conversation_id FROM pending_actions WHERE id = $1', [p.pendingActionId]);
    if (!row || row.client_id !== client.id) return foreign(ctx, client.lang);
    await ctx.answerCallbackQuery();                                            // at once (10 §4.4)
    await ctx.editMessageReplyMarkup().catch(() => {});                         // the buttons go: no second press
    const conv = row.conversation_id ? await db.one('SELECT lang, state FROM conversations WHERE id = $1', [row.conversation_id]) : null;
    const lang = conv?.lang ?? client.lang;
    const r = await answerDraft(tools, p, { actor: actorOf(client), source: 'agent', lang, conversationId: row.conversation_id,
      contactPhone: conv?.state?.contactPhone ?? null, onCommit: core.onCommit, render: core.render }, env);
    await deliver(ctx, { text: r.text, blocks: r.blocks ?? [], suggestions: r.suggestions ?? [] }, lang);
  }

  // sg:<messageId>:<i> — hint №i under a stored answer; the hint itself lies in messages.blocks (10 §4.4).
  async function onSuggestion(ctx, client) {
    const [, id, i] = /^sg:(\d{1,15}):(\d{1,2})$/.exec(ctx.match[0]) ?? [];
    const m = id && await db.one(`SELECT m.blocks, c.client_id FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = $1 AND m.role = 'assistant'`, [id]);
    if (!m || m.client_id !== client.id) return foreign(ctx, client.lang);
    const s = (m.blocks ?? []).find(b => b.type === 'suggestions')?.data?.[Number(i)];
    if (!s?.intent) return ctx.answerCallbackQuery({ text: t(client.lang, 'tg.stale_button'), show_alert: true });
    await ctx.answerCallbackQuery();
    await run(ctx, client, { intent: s.intent, payload: s.payload ?? {} });
  }

  // sgi:<intent>[:<n>] — a button of a scripted answer or of an apartment card.
  async function onShort(ctx, client) {
    const [, intent, n] = SHORT.exec(ctx.match[0]) ?? [];
    if (!intent) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    await run(ctx, client, { intent, payload: n && PAYLOAD_KEY[intent] ? { [PAYLOAD_KEY[intent]]: Number(n) } : {} });
  }

  // src:<messageId>:<n> — «Показать источник n»: the whole fragment the answer stands on (09 §6).
  async function onSource(ctx, client) {
    const [, id, n] = /^src:(\d{1,15}):(\d{1,2})$/.exec(ctx.match[0]) ?? [];
    const m = id && await db.one(`SELECT m.blocks, c.client_id, c.lang FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = $1 AND m.role = 'assistant'`, [id]);
    if (!m || m.client_id !== client.id) return foreign(ctx, client.lang);
    const block = (m.blocks ?? []).find(b => b.type === 'citations')?.data;
    const c = block?.items?.find(x => x.n === Number(n));
    if (!c) return ctx.answerCallbackQuery({ text: t(client.lang, 'tg.stale_button'), show_alert: true });
    await ctx.answerCallbackQuery();
    const meta = [c.score != null ? t(m.lang, 'tg.src_match', { pct: Math.round(c.score * 100) }) : null,
      block.mode === 'keyword_only' ? t(m.lang, 'tg.src_words') : null].filter(Boolean).join(' · ');
    await ctx.api.sendMessage(ctx.chat.id, `<b>[${c.n}] ${esc(c.heading)}</b>\n${esc(c.text)}${meta ? `\n<i>${esc(meta)}</i>` : ''}`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  }

  // fb:<messageId>:<1|-1> — 👍 / 👎 under an answer (07 §16.3).
  async function onFeedback(ctx, client) {
    const [, id, v] = /^fb:(\d{1,15}):(1|-1)$/.exec(ctx.match[0]) ?? [];
    const m = id && await db.one(`SELECT m.id, c.client_id FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = $1 AND m.role = 'assistant'`, [id]);
    if (!m || m.client_id !== client.id) return foreign(ctx, client.lang);
    await db.query('UPDATE messages SET feedback = $2 WHERE id = $1', [m.id, Number(v)]);
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup().catch(() => {});
  }

  // visitor(ctx) → { client } as in bot.js.
  function mount(dm, visitor) {
    const own = fn => async ctx => fn(ctx, (await visitor(ctx)).client);
    dm.callbackQuery(/^pa:[0-9a-f-]{36}:[yenr]$/, own(onDraft));
    dm.callbackQuery(/^sg:\d{1,15}:\d{1,2}$/, own(onSuggestion));
    dm.callbackQuery(SHORT, own(onShort));
    dm.callbackQuery(/^src:\d{1,15}:\d{1,2}$/, own(onSource));
    dm.callbackQuery(/^fb:\d{1,15}:(?:1|-1)$/, own(onFeedback));
  }

  return { run, mount, conversationOf, messagesOf };
}
