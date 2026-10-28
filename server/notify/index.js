// What the core and the runner get for notifications: render (always) and send (only with a bot token).
import { createRender } from './render.js';
import { createSender } from './telegramSender.js';

// db — for the files of send_document rows (the booking PDF is built from the base at delivery, 05 §10.4).
export function createNotify(env = process.env, { db = null } = {}) {
  const document = db && (async row => (await import('../payments/pdf.js')).bookingPdf(db, row.attachment.bookingId, { lang: row.lang, env }));
  const render = createRender(env);
  return { render, send: createSender({ token: env.TELEGRAM_BOT_TOKEN, document, render }) };
}
