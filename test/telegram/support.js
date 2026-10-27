// A bot over the test base with the Telegram API replaced (10 §10): every call is recorded, nothing leaves the machine.
import { createBot } from '../../server/telegram/bot.js';

export const ENV = { TELEGRAM_BOT_TOKEN: '123456:TEST-TOKEN', TELEGRAM_BOT_USERNAME: 'chinorpark_test_bot',
  TELEGRAM_WEBHOOK_SECRET: 'w'.repeat(40), PUBLIC_URL: 'https://domus.test', LINK_SECRET: 'test-secret', TELEGRAM_STAFF_CHAT_ID: '-100500' };

// → { bot, calls, sent() }: calls — [{ method, payload }] in order; sent() — only the texts of sendMessage.
export function makeBot(db, { env = ENV, core = {} } = {}) {
  const bot = createBot({ db, env, core });
  const calls = [];
  let id = 1000;
  bot.api.config.use((prev, method, payload) => {
    calls.push({ method, payload });
    const result = method === 'sendMessage' ? { message_id: ++id, date: 0, chat: { id: payload.chat_id, type: 'private' }, text: payload.text } : true;
    return Promise.resolve({ ok: true, result });
  });
  return { bot, calls, sent: () => calls.filter(c => c.method === 'sendMessage') };
}

let updateId = 1;
export const FROM = { id: 77, is_bot: false, first_name: 'Аня', username: 'anya', language_code: 'ru' };

const message = (from, extra) => ({ update_id: updateId++, message: { message_id: updateId, date: 1_790_000_000,
  chat: { id: from.id, type: 'private', first_name: from.first_name }, from, ...extra } });

export const text = (str, from = FROM) => message(from, { text: str,
  ...(str.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: str.split(/\s/)[0].length }] } : {}) });
export const start = (payload = '', from = FROM) => text(payload ? `/start ${payload}` : '/start', from);
export const contact = (phone, userId, from = FROM) => message(from, { contact: { phone_number: phone, first_name: from.first_name, user_id: userId } });
// chat — where the button is: the private chat by default, { id: -100500, type: 'supergroup' } for the staff group.
export const callback = (data, from = FROM, chat = { id: from.id, type: 'private' }) => ({ update_id: updateId++, callback_query: { id: `cb${updateId}`, from, chat_instance: 'x', data,
  message: { message_id: 5, date: 1_790_000_000, chat, text: '…' } } });

// The bot's own membership in a chat changed (the group): status — member | administrator | left | kicked.
export const myChatMember = (status, chat = { id: -100500, type: 'supergroup', title: 'Домус · продажи' }, by = { id: 1, is_bot: false, first_name: 'Admin' }) => ({
  update_id: updateId++, my_chat_member: { chat, from: by, date: 1_790_000_000,
    old_chat_member: { user: { id: 123456, is_bot: true, first_name: 'bot' }, status: 'member' },
    new_chat_member: { user: { id: 123456, is_bot: true, first_name: 'bot' }, status } } });

// The keyboard of a sent message: rows of button texts.
export const buttons = call => (call.payload.reply_markup?.keyboard ?? call.payload.reply_markup?.inline_keyboard ?? []).map(row => row.map(b => b.text ?? b));
