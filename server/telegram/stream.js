// The stream of an answer in Telegram (10 §5.1, D-12): the draft of the message grows while the agent writes
// (sendMessageDraft, not more often than every 800 ms and by ≥ 20 characters); without the method — «печатает…»
// every 4 s and the finished message. The mode is found at the first call and kept by the instance.
import { now } from '../core/clock.js';

export const DRAFT_EVERY_MS = 800;
export const DRAFT_MIN_CHARS = 20;
export const TYPING_EVERY_MS = 4000;

const gone = e => [400, 404].includes(e?.error_code);
let draftMode = null;                               // null = not known yet, 'draft' | 'typing'
export const resetDraftMode = () => { draftMode = null; };

// → { event(ev), stop() }. api — grammy's Api; draftId must be a non-zero number, the same for one reply.
export function createReplyStream({ api, chatId, draftId, resetText = '…', typingEveryMs = TYPING_EVERY_MS, log = console }) {
  let text = '';              // the accumulated text of the answer
  let sentText = '';          // what the draft shows now
  let shownLen = 0;           // how much of `text` the draft has already shown
  let sentAt = 0;
  let timer = null;
  let stopped = false;
  let chain = Promise.resolve();                     // the calls go one after another, in order
  const enqueue = fn => (chain = chain.then(fn).catch(e => log.warn?.('telegram stream:', e?.error_code ?? e?.name)));

  const typing = () => api.sendChatAction(chatId, 'typing');
  const startTyping = () => {
    if (timer || stopped) return;
    timer = setInterval(() => { enqueue(typing); }, typingEveryMs);
    timer.unref?.();
  };

  // The draft is shown only when the method works; the first refusal switches the instance to «печатает…».
  function draft(body) {
    if (!body || body === sentText || stopped) return;
    if (draftMode === 'typing') return;
    sentText = body;
    sentAt = now().getTime();
    enqueue(async () => {
      try {
        await api.raw.sendMessageDraft({ chat_id: chatId, draft_id: draftId, text: body.slice(0, 4096) });
        draftMode = 'draft';
      } catch (e) {
        if (!gone(e)) throw e;
        draftMode = 'typing';
        startTyping();
      }
    });
  }

  enqueue(typing);                                   // the start of the turn: «печатает…» holds for 5 s
  if (draftMode === 'typing') startTyping();

  return {
    event(ev) {
      if (stopped) return;
      if (ev.type === 'status') draft(ev.data?.text);
      else if (ev.type === 'reset') { text = ''; shownLen = 0; draft(resetText); }
      else if (ev.type === 'text') {
        text += ev.delta ?? '';
        if (now().getTime() - sentAt >= DRAFT_EVERY_MS && text.length - shownLen >= DRAFT_MIN_CHARS) { shownLen = text.length; draft(text); }
      }
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      await chain;
    }
  };
}
