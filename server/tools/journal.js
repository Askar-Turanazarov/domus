// The call log for the site's «Журнал вызовов» (tool_calls, server/db/legacy.js logCall).
// Never holds the token, a name or a phone.

// book_viewing carries a name and a phone: only the apartment and the time go to the log. Pure.
export function safeArgs(tool, args = {}) {
  if (tool !== 'book_viewing') return args;
  const { no, datetime } = args;
  return { no, datetime };
}
