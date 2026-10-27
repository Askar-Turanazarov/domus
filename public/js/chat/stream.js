// The stream of the chat (11 §5.2): POST /api/chat with fetch + ReadableStream (EventSource cannot POST) and a parser of
// the lines `event:` / `data:`. The parser takes pieces of any size — a line may break in the middle of a word or of a
// multi-byte letter. A comment line (`: ping`) is not an event.

// → { push(chunk: string), end() } ; onEvent({ event, data }) — data is the parsed JSON of the event.
export function createSseParser(onEvent) {
  let buf = '';
  let event = 'message';
  let data = [];
  const flush = () => {
    if (data.length) {
      try { onEvent({ event, data: JSON.parse(data.join('\n')) }); } catch { /* a broken event is dropped */ }
    }
    event = 'message';
    data = [];
  };
  const line = l => {
    if (l === '') return flush();
    if (l.startsWith(':')) return;
    const i = l.indexOf(':');
    const field = i < 0 ? l : l.slice(0, i);
    const value = i < 0 ? '' : l.slice(i + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  };
  return {
    push(chunk) {
      buf += chunk;
      let nl;
      while ((nl = buf.search(/\r\n|\n|\r/)) >= 0) {
        const l = buf.slice(0, nl);
        const skip = buf.startsWith('\r\n', nl) ? 2 : 1;
        // a lone «\r» at the very end may be the first half of «\r\n»: wait for the next piece
        if (buf[nl] === '\r' && nl + 1 === buf.length) break;
        buf = buf.slice(nl + skip);
        line(l);
      }
    },
    end() {
      if (buf) { const l = buf; buf = ''; line(l); }
      flush();
    }
  };
}

// The whole text of a stream at once → the events (tests, the browser's fallback).
export function* parseSse(text) {
  const out = [];
  const p = createSseParser(e => out.push(e));
  p.push(text);
  p.end();
  yield* out;
}

// Posts `body` and reads the stream; onEvent for each event. Resolves when the stream ends; rejects with
// { status, body } for an answer that is not a stream (409, 429, 400 — JSON of 13 §1.2), with the abort error on abort.
// opts — { signal, headers, fetchImpl }.
export async function streamChat(url, body, onEvent, { signal, headers = {}, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, { method: 'POST', signal, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...headers }, body: JSON.stringify(body) });
  if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    throw Object.assign(new Error(json?.error ?? `http_${res.status}`), { status: res.status, body: json });
  }
  const parser = createSseParser(onEvent);
  const dec = new TextDecoder();
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.push(dec.decode(value, { stream: true }));
  }
  parser.push(dec.decode());
  parser.end();
}
