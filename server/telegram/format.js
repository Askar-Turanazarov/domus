// The look of an agent's answer in Telegram (10 §5.2): the simple Markdown of the agents (07 §7.2) → HTML of the Bot API.
// `**x**` → <b>x</b>, lists → «• », <, >, & escaped; MarkdownV2 is not used — its escaping breaks on prices with dots and brackets.
import { esc, escAttr, money } from '../notify/format.js';

export const LIMIT = 4096;       // the Bot API's limit of one message

// Links: only to our own site (the address of PUBLIC_URL or a path); a foreign address stays plain text (11 §14, 14 §).
const linkOf = (url, base) => {
  if (/^\/(?![/\\])/.test(url)) return base ? base + url : null;
  try {
    const u = new URL(url);
    return base && u.origin === new URL(base).origin && /^https?:$/.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
};

// → one HTML string (no splitting).
export function toHtml(md, { base = '' } = {}) {
  const root = String(base ?? '').replace(/\/$/, '');
  return String(md ?? '').replace(/\r\n?/g, '\n').split('\n').map(line => {
    const bullet = /^\s*[-*•]\s+(.*)$/u.exec(line);
    const body = bullet ? bullet[1] : line;
    let out = '';
    let last = 0;
    for (const m of body.matchAll(/\*\*([^*\n]+?)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)/gu)) {
      out += esc(body.slice(last, m.index));
      last = m.index + m[0].length;
      if (m[1] != null) out += `<b>${esc(m[1])}</b>`;
      else {
        const href = linkOf(m[3], root);
        out += href ? `<a href="${escAttr(href)}">${esc(m[2])}</a>` : esc(m[2]);
      }
    }
    out += esc(body.slice(last));
    return bullet ? `• ${out}` : out;
  }).join('\n');
}

// A long answer is cut by paragraphs (then by lines, then hard) before the conversion, so no tag is torn.
export function splitText(md, max = LIMIT, opts) {
  const parts = [];
  let cur = '';
  const push = piece => {
    const next = cur ? `${cur}\n\n${piece}` : piece;
    if (toHtml(next, opts).length <= max) { cur = next; return; }
    if (cur) parts.push(cur);
    cur = '';
    if (toHtml(piece, opts).length <= max) { cur = piece; return; }
    for (const line of piece.split('\n')) {                        // a paragraph longer than a message: by lines
      const n = cur ? `${cur}\n${line}` : line;
      if (toHtml(n, opts).length <= max) { cur = n; continue; }
      if (cur) parts.push(cur);
      cur = '';
      let rest = line;
      while (toHtml(rest, opts).length > max) {                    // one line longer than a message: hard cut
        let cut = Math.floor(max / 2);
        while (cut > 1 && toHtml(rest.slice(0, cut), opts).length > max) cut = Math.floor(cut / 2);
        parts.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      cur = rest;
    }
  };
  for (const p of String(md ?? '').trim().split(/\n{2,}/)) if (p.trim()) push(p);
  if (cur) parts.push(cur);
  return parts.map(p => toHtml(p, opts));
}

const pad = (s, n, right) => (right ? String(s).padStart(n) : String(s).padEnd(n));

// The table block (10 §5.2): a monospace <pre>, up to 6 rows. → { html, more } — more: the table is longer than shown.
export function tableHtml(d, t, lang) {
  const rows = d.rows ?? (d.plans ?? []).map(p => ({ kind: 'installment', months: p.months, down: p.down, monthly: p.monthly, overpay: p.markup }));
  const cols = (rows.some(r => r.kind === 'mortgage') ? ['kind'] : []).concat(['term', 'down', 'monthly', 'over']);
  const label = c => t(lang, `tg.t.${c}`);
  const cell = (r, c) => ({ kind: t(lang, `tg.t.${r.kind}`), term: t(lang, 'tg.t.months', { n: r.months }), down: money(r.down),
    monthly: money(r.monthly), over: r.overpay == null ? '—' : money(r.overpay) })[c];
  const shown = rows.slice(0, 6);
  const table = [cols.map(label), ...shown.map(r => cols.map(c => cell(r, c)))];
  const w = cols.map((_, i) => Math.max(...table.map(r => [...r[i]].length)));
  const text = table.map(r => r.map((x, i) => pad(x, w[i], i > 0)).join('  ')).join('\n');
  return { html: `<pre>${esc(text)}</pre>`, more: rows.length > shown.length };
}
