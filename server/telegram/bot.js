// The client bot (10 §4): /start in its four forms, the contact (R2), the language, help, the menu, the dialogue with the AI agent
// (free text, menu tasks, buttons — telegram/agent.js). The staff group (take:, the bot's membership) is at the end. Every reply is a direct answer to the
// update; notifications go through the Outbox (server/notify).
import { Bot, InlineKeyboard, Keyboard } from 'grammy';
import { DomainError } from '../core/errors.js';
import { resolveClient, attachTelegram, verifyPhone, unblockTelegram, setLang, assignClient } from '../core/clients.js';
import { attachStaffTelegram, staffByTelegram, setStaffChatState } from '../core/staff.js';
import { getApartment } from '../core/apartments.js';
import { context } from '../core/tx.js';
import { t } from '../i18n/index.js';
import { money, areaText } from '../notify/format.js';
import { createTelegramAgent, MENU_INTENTS } from './agent.js';

export const LANGS = ['ru', 'uz', 'en'];
const MENU_KEYS = ['pick', 'open', 'bookings', 'manager'];

// from.language_code ('uz', 'ru', 'en-US', …) → our language; anything else is Russian (10 §4.1).
export function langOfTelegram(code) {
  const l = String(code ?? '').slice(0, 2).toLowerCase();
  return LANGS.includes(l) ? l : 'ru';
}

// "TELEGRAM_BOT_TOKEN" → the bot's own user without a getMe round trip on every cold start.
export function botInfoOf(token, username) {
  return { id: Number(String(token).split(':')[0]), is_bot: true, first_name: username, username: String(username).replace(/^@/, ''),
    can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false,
    has_main_web_app: false };
}

// web_app buttons need https. Until the mini app (D4-12, /mini) exists the button opens the showcase itself.
const MINI_PATH = '/';
export function miniUrl(env) {
  const base = String(env.PUBLIC_URL ?? '').replace(/\/$/, '');
  return base.startsWith('https://') ? base + MINI_PATH : null;
}

// The persistent main menu (10 §4.1); the contact button only while the phone is not confirmed.
export function menuKeyboard(client, env) {
  const lang = client.lang;
  const kb = new Keyboard().text(t(lang, 'tg.btn.pick'));
  const url = miniUrl(env);
  if (url) kb.webApp(t(lang, 'tg.btn.open'), url); else kb.text(t(lang, 'tg.btn.open'));
  kb.row().text(t(lang, 'tg.btn.bookings')).text(t(lang, 'tg.btn.manager'));
  if (!client.phone_verified) kb.row().requestContact(t(lang, 'tg.btn.phone'));
  return kb.persistent().resized();
}

export const langKeyboard = () => new InlineKeyboard()
  .text('🇷🇺 Русский', 'lang:ru').text('🇺🇿 O‘zbekcha', 'lang:uz').text('🇬🇧 English', 'lang:en');

const menuKey = text => MENU_KEYS.find(k => LANGS.some(l => t(l, `tg.btn.${k}`) === text));
const asClient = c => ({ type: 'client', id: c.id, role: 'client', channel: 'telegram' });

// core — extra options of the core calls ({ now, onCommit, render }); tests put a transformer on bot.api.config.
// turns, tools — the agent layer (D3); without them the bot answers free text with a stub.
export function createBot({ db, env = process.env, core = {}, token = env.TELEGRAM_BOT_TOKEN, turns = null, tools = null }) {
  const bot = new Bot(token, { botInfo: botInfoOf(token, env.TELEGRAM_BOT_USERNAME || 'bot') });
  const opts = { ...core, env };
  // An error of a handler goes up to the webhook, which writes its code into telegram_updates (10 §3).
  bot.catch(err => { throw err.error ?? err; });

  // R1: the card of this Telegram user, made on the first visit. /start lifts the «blocked» mark (10 §9).
  async function visitor(ctx) {
    const { from, chat } = ctx;
    return db.tx(async q => {
      const was = await q.one('SELECT 1 AS found FROM clients WHERE telegram_user_id = $1', [from.id]);
      const client = await resolveClient(q, { telegram: { userId: from.id, username: from.username, chatId: chat.id },
        lang: langOfTelegram(from.language_code) }, 'telegram', { type: 'system' }, opts);
      if (client.tg_blocked_at) await unblockTelegram(q, client.id);
      return { client, isNew: !was };
    });
  }

  const reply = (ctx, client, text, extra = {}) => ctx.reply(text, { reply_markup: menuKeyboard(client, env), ...extra });

  async function startPlain(ctx, extra) {
    const { client, isNew } = await visitor(ctx);
    if (isNew) await ctx.reply(t(client.lang, 'tg.choose_lang'), { reply_markup: langKeyboard() });
    await reply(ctx, client, t(client.lang, 'tg.welcome'));
    if (extra) await extra(client);
  }

  // /start apt_<no>: the menu and the card of the apartment.
  async function startApartment(ctx, no) {
    await startPlain(ctx, async client => {
      const apt = Number.isInteger(no) ? await getApartment(db, no, context(opts)) : null;
      if (!apt) return ctx.reply(t(client.lang, 'tg.apt_missing', { no }));
      const text = t(client.lang, 'tg.apt_card', { no: apt.no, rooms: apt.rooms, area: areaText(apt.area, client.lang), floor: apt.floor,
        price: money(apt.price), status: t(client.lang, `tg.apt_status.${apt.status}`) });
      const site = miniUrl(env);
      await ctx.reply(text, site ? { reply_markup: new InlineKeyboard().url(t(client.lang, 'tg.open_site'), `${site.replace(/\/$/, '')}/${client.lang}`) } : {});
    });
  }

  // /start lk_<code> (R6): the site card gets this Telegram. The «Готово!» message is the Outbox template link_telegram_done.
  async function startLink(ctx, code) {
    const lang = langOfTelegram(ctx.from.language_code);
    let r;
    try {
      r = await attachTelegram(db, { code, telegram: { userId: ctx.from.id, username: ctx.from.username, chatId: ctx.chat.id } }, opts);
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      return ctx.reply(t(lang, e.code === 'telegram_linked_elsewhere' ? 'tg.linked_elsewhere' : 'tg.link_invalid'));
    }
    if (r.client.tg_blocked_at) await unblockTelegram(db, r.client.id);
    await reply(ctx, r.client, t(r.client.lang, 'tg.menu_hint'));
  }

  // /start st_<code> (FR-ADM-11): a staff member links their Telegram; no client card is made.
  async function startStaff(ctx, code) {
    const lang = langOfTelegram(ctx.from.language_code);
    try {
      const s = await attachStaffTelegram(db, { code, telegram: { userId: ctx.from.id, username: ctx.from.username } }, opts);
      await ctx.reply(t(s.lang, 'tg.staff_linked', { name: s.name, role: t(s.lang, `tg.role.${s.role}`) }));
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      await ctx.reply(t(lang, e.code === 'telegram_linked_elsewhere' ? 'tg.linked_elsewhere' : 'tg.staff_invalid'));
    }
  }

  const dm = bot.chatType('private');
  const agent = turns && tools ? createTelegramAgent({ db, turns, tools, env, core: opts }) : null;

  dm.command('start', async ctx => {
    const arg = String(ctx.match ?? '').trim();
    if (arg.startsWith('lk_')) return startLink(ctx, arg.slice(3));
    if (arg.startsWith('st_')) return startStaff(ctx, arg.slice(3));
    if (/^apt_\d{1,6}$/.test(arg)) return startApartment(ctx, Number(arg.slice(4)));
    return startPlain(ctx);
  });

  dm.command('help', async ctx => {
    const { client } = await visitor(ctx);
    const base = String(env.PUBLIC_URL ?? '').replace(/\/$/, '');
    await reply(ctx, client, t(client.lang, 'tg.help', { privacy: base ? `${base}/legal/privacy?lang=${client.lang}` : '' }).trim());
  });

  dm.command('lang', async ctx => {
    const { client } = await visitor(ctx);
    await ctx.reply(t(client.lang, 'tg.choose_lang'), { reply_markup: langKeyboard() });
  });

  dm.callbackQuery(/^lang:(ru|uz|en)$/, async ctx => {
    await ctx.answerCallbackQuery();                                   // at once, before the work (10 §4.4)
    const lang = ctx.match[1];
    const { client } = await visitor(ctx);
    const updated = await db.tx(q => setLang(q, client.id, lang));
    await ctx.editMessageReplyMarkup().catch(() => {});                // the buttons go, so the choice is not pressed twice
    await reply(ctx, updated, t(lang, 'tg.lang_set'));
  });

  // R2: the shared contact must be the sender's own (contact.user_id === from.id).
  dm.on('message:contact', async ctx => {
    const { client } = await visitor(ctx);
    const contact = ctx.message.contact;
    if (contact.user_id !== ctx.from.id) return reply(ctx, client, t(client.lang, 'tg.phone_foreign'));
    const digits = String(contact.phone_number ?? '');
    const r = await verifyPhone(db, { clientId: client.id, phone: digits.startsWith('+') ? digits : `+${digits}` }, asClient(client), opts);
    await reply(ctx, r.client, t(r.client.lang, r.conflict ? 'tg.phone_conflict' : 'tg.phone_ok'));
  });

  // Not text (10 §4.3): a photo, a file, a sticker, a voice, a place — a short answer, no AI.
  dm.on(['message:photo', 'message:document', 'message:sticker', 'message:voice', 'message:video', 'message:video_note',
    'message:audio', 'message:animation', 'message:location'], async ctx => {
    const { client } = await visitor(ctx);
    await reply(ctx, client, t(client.lang, 'tg.nontext'));
  });

  // «Мои брони», «Подобрать квартиру», «Связаться с менеджером» and the free text are turns of the agent (10 §4.2–4.3).
  const task = async (ctx, intent) => {
    const { client } = await visitor(ctx);
    if (!agent) return reply(ctx, client, t(client.lang, 'tg.soon'));
    await agent.run(ctx, client, { intent });
  };
  dm.command('bookings', ctx => task(ctx, MENU_INTENTS.bookings));

  dm.on('message:text', async ctx => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return;                                  // an unknown command: no answer, no noise
    const key = menuKey(text);
    if (MENU_INTENTS[key]) return task(ctx, MENU_INTENTS[key]);
    const { client } = await visitor(ctx);
    if (!agent) return reply(ctx, client, t(client.lang, key ? 'tg.soon' : 'tg.text_soon'));
    if (key) return reply(ctx, client, t(client.lang, 'tg.soon'));     // «Открыть ЖК» without https: the mini app comes with D4
    await agent.run(ctx, client, { text });
  });

  agent?.mount(dm, visitor);

  // ── the staff group (10 §6): «Беру клиента» and the bot's own membership
  const inStaffChat = ctx => String(ctx.chat?.id) === String(env.TELEGRAM_STAFF_CHAT_ID ?? '');

  bot.callbackQuery(/^take:([0-9a-f-]{36})$/, async ctx => {
    const alert = text => ctx.answerCallbackQuery({ text, show_alert: true });
    if (!inStaffChat(ctx)) return alert(t('ru', 'tg.not_for_you'));       // a forwarded message: the button is for the group only
    const staff = await staffByTelegram(db, ctx.from.id);
    if (!staff) return alert(t('ru', 'tg.take_unlinked'));
    const r = await assignClient(db, { clientId: ctx.match[1], staffId: staff.id }, opts).catch(e => {
      if (e instanceof DomainError) return null;
      throw e;
    });
    if (!r) return alert(t(staff.lang, 'tg.not_for_you'));
    if (r.taken) return ctx.answerCallbackQuery({ text: t(staff.lang, 'tg.take_ok') });
    return alert(r.by.id === staff.id ? t(staff.lang, 'tg.take_mine') : t(staff.lang, 'tg.take_taken', { name: r.by.name }));
  });

  // The bot left or was removed from the group: the Outbox stops writing there until it is back (10 §6.3).
  bot.on('my_chat_member', async ctx => {
    if (!inStaffChat(ctx)) return;
    const status = ctx.myChatMember.new_chat_member.status;
    const state = ['left', 'kicked'].includes(status) ? 'removed' : ['member', 'administrator'].includes(status) ? 'ok' : null;
    if (state) await db.tx(q => setStaffChatState(q, state, opts));
  });

  // «Связаться с менеджером» under the reminders: the dialogue with a manager comes with D3.
  bot.callbackQuery('mgr', ctx => ctx.answerCallbackQuery({ text: t('ru', 'tg.soon'), show_alert: true }));

  // Any other button: the clock must stop spinning (10 §4.4).
  bot.on('callback_query:data', ctx => ctx.answerCallbackQuery());

  return bot;
}
