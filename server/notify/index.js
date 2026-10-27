// What the core and the runner get for notifications: render (always) and send (only with a bot token).
import { createRender } from './render.js';
import { createSender } from './telegramSender.js';

export function createNotify(env = process.env) {
  return { render: createRender(env), send: createSender({ token: env.TELEGRAM_BOT_TOKEN }) };
}
