// npm run tg:setup [-- --prod] (10 §2.2): the webhook with its secret, the commands in three languages, the menu button,
// the descriptions; then getWebhookInfo. By default the TEST bot and PUBLIC_URL (a tunnel); --prod takes TELEGRAM_PROD_*
// and PROD_PUBLIC_URL. Tokens are never printed. A step that needs an https address is skipped when there is none.
import { t } from '../server/i18n/index.js';

const prod = process.argv.includes('--prod');
const env = process.env;
const pick = name => (prod ? env[`TELEGRAM_PROD_${name}`] : env[`TELEGRAM_${name}`]) ?? '';
const token = pick('BOT_TOKEN');
const secret = pick('WEBHOOK_SECRET');
const base = String((prod ? env.PROD_PUBLIC_URL : env.PUBLIC_URL) ?? '').trim().replace(/\/$/, '');
const label = prod ? 'main bot (--prod)' : 'test bot';

if (!token) {
  console.error(`${label}: ${prod ? 'TELEGRAM_PROD_BOT_TOKEN' : 'TELEGRAM_BOT_TOKEN'} is empty — fill .env`);
  process.exit(1);
}
if (secret.length < 32 || !/^[A-Za-z0-9_-]+$/.test(secret)) {
  console.error(`${label}: the webhook secret must be 32+ characters of A-Za-z0-9_-`);
  process.exit(1);
}

async function call(method, body = {}) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(`${method}: ${json.description ?? res.status}`);
  return json.result;
}

const me = await call('getMe');
console.log(`${label}: @${me.username}`);

if (base.startsWith('https://')) {
  await call('setWebhook', { url: `${base}/api/telegram/webhook`, secret_token: secret,
    allowed_updates: ['message', 'callback_query', 'my_chat_member'], drop_pending_updates: true, max_connections: 10 });
  console.log(`webhook set: ${base}/api/telegram/webhook`);
} else {
  console.log('webhook NOT set: no https address (PUBLIC_URL / PROD_PUBLIC_URL) — the bot will not receive updates');
}

const COMMANDS = ['start', 'bookings', 'lang', 'help'];
const LANGS = ['ru', 'uz', 'en'];
for (const lang of LANGS) {
  await call('setMyCommands', { commands: COMMANDS.map(c => ({ command: c, description: t(lang, `tg.cmd.${c}`) })), language_code: lang });
}
await call('setMyCommands', { commands: COMMANDS.map(c => ({ command: c, description: t('ru', `tg.cmd.${c}`) })) });

for (const lang of LANGS) {
  await call('setMyDescription', { description: t(lang, 'tg.desc'), language_code: lang });
  await call('setMyShortDescription', { short_description: t(lang, 'tg.short'), language_code: lang });
}
await call('setMyDescription', { description: t('ru', 'tg.desc') });
await call('setMyShortDescription', { short_description: t('ru', 'tg.short') });
console.log('commands and descriptions set (ru, uz, en)');

// The mini app (/mini, D4-12) does not exist yet: the button opens the showcase until then (server/telegram/bot.js MINI_PATH).
if (base.startsWith('https://')) {
  await call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Chinor Park', web_app: { url: `${base}/` } } });
  console.log('menu button set');
}

const info = await call('getWebhookInfo');
console.log('webhookInfo:', JSON.stringify({ url: info.url, pending: info.pending_update_count, lastError: info.last_error_message ?? null,
  lastErrorDate: info.last_error_date ?? null, maxConnections: info.max_connections ?? null }));
