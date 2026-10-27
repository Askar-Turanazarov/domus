// Documents of the knowledge base → chunks (09 §2.1, §3). A chunk is a `##` section; a section longer than MAX_CHARS is cut
// by sentences into parts of up to MAX_CHARS, each part starting with the last sentence of the previous one.
import crypto from 'node:crypto';

export const MAX_CHARS = 900;

export const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

// Frontmatter without libraries: «key: value» lines between two «---». → { meta, body }.
export function parseDoc(src) {
  const text = String(src).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  const meta = {};
  if (m) for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: m ? text.slice(m[0].length) : text };
}

// → [{ heading, text }]; text before the first `##` is a section named after the document title.
export function sections(body, title) {
  const out = [];
  let cur = { heading: title, lines: [] };
  for (const line of body.split('\n')) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { out.push(cur); cur = { heading: `${title} — ${h[1]}`, lines: [] }; } else cur.lines.push(line);
  }
  out.push(cur);
  return out.map(s => ({ heading: s.heading, text: s.lines.join('\n').trim() })).filter(s => s.text);
}

// A section → parts of up to `max` characters. Paragraphs are kept apart by a blank line.
export function splitText(text, max = MAX_CHARS) {
  if (text.length <= max) return [text];
  const units = [];                                                       // sentences, with the paragraph they belong to
  text.split(/\n{2,}/).forEach((p, pi) => {
    for (const s of p.replace(/\s*\n\s*/g, ' ').split(/(?<=[.!?…])\s+/)) if (s.trim()) units.push({ s: s.trim(), pi });
  });
  const cut = [];                                                         // one sentence longer than a part: hard cut
  for (const u of units) {
    for (let i = 0; i < u.s.length; i += max) cut.push({ s: u.s.slice(i, i + max), pi: u.pi });
  }
  const join = list => list.map((u, i) => (i === 0 ? '' : u.pi === list[i - 1].pi ? ' ' : '\n\n') + u.s).join('');
  const parts = [];
  let cur = [];
  let fresh = 0;                                                          // how many units of `cur` are new (not the overlap)
  for (const u of cut) {
    if (cur.length && join([...cur, u]).length > max) {
      parts.push(join(cur));
      const last = cur.at(-1);
      cur = join([last, u]).length <= max ? [last] : [];
      fresh = 0;
    }
    cur.push(u);
    fresh++;
  }
  if (fresh > 0) parts.push(join(cur));
  return parts;
}

// → { meta, chunks: [{ ord, heading, text, embedText, hash }] }. Embedding text: heading + blank line + text (09 §3).
export function chunkDocument(src, fallbackTitle = '') {
  const { meta, body } = parseDoc(src);
  const title = meta.title || fallbackTitle;
  const chunks = [];
  for (const sec of sections(body, title)) {
    for (const text of splitText(sec.text)) {
      const embedText = `${sec.heading}\n\n${text}`;
      chunks.push({ ord: chunks.length, heading: sec.heading, text, embedText, hash: sha256(embedText) });
    }
  }
  return { meta: { ...meta, title }, chunks };
}
