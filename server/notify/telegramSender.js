// send(row) for core/outbox.deliver (04 §3.2): one Outbox row → one Telegram call → a result classify() understands.
// It never throws: a Telegram error is a { ok: false, status, … }, a network failure or timeout is { ok: false, network: true }.
import { Api, GrammyError, HttpError } from 'grammy';

const TIMEOUT_MS = 10_000;

// What of `rendered` goes to Telegram (the rest of the row is ours).
const options = r => ({ parse_mode: r.parse_mode, reply_markup: r.reply_markup, link_preview_options: r.link_preview_options });

// → send(row) | null (no token: the bot is off, rows wait in the Outbox). api — a ready Api (tests).
export function createSender({ token, api = token ? new Api(token) : null } = {}) {
  if (!api) return null;
  return async function send(row) {
    const r = row.rendered;
    if (!r?.text) return { ok: false, status: 400, description: 'no rendered message' };       // a template bug: repeating will not help
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    try {
      if (row.op === 'edit') {
        await api.editMessageText(row.chat_id, Number(row.edit_message_id), r.text, options(r), signal);
        return { ok: true };
      }
      if (row.op === 'send') {
        const m = await api.sendMessage(row.chat_id, r.text, options(r), signal);
        return { ok: true, messageId: m.message_id };
      }
      return { ok: false, status: 400, description: `op ${row.op} is not supported yet` };     // send_document: the PDF (S, 05 §10)
    } catch (e) {
      if (e instanceof GrammyError) {
        return { ok: false, status: e.error_code, description: e.description, retryAfter: e.parameters?.retry_after };
      }
      if (e instanceof HttpError || e?.name === 'TimeoutError' || e?.name === 'AbortError') {
        return { ok: false, network: true, description: String(e.message ?? e.name) };
      }
      throw e;                                                                                  // deliver() counts a throw as a network error
    }
  };
}
