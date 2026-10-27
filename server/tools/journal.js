// The call log for the site's «Журнал вызовов»: mcp-calls.jsonl locally, Postgres on Vercel (server/db.js logCall).
// Never holds the token, a name or a phone.

// the file log (one queue per file, trimmed past 1 MB) lives with the site's storage
export { logEvent } from '../callLog.js';

// book_viewing carries a name and a phone: only the apartment and the time go to the log. Pure.
export function safeArgs(tool, args = {}) {
  if (tool !== 'book_viewing') return args;
  const { no, datetime } = args;
  return { no, datetime };
}
