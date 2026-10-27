// The safe Markdown of the chat (11 §5.3, §14): `**bold**`, lists, links only to our own domain. The text of a model never
// goes through innerHTML — everything is built with createElement / createTextNode, so «<script>» is just letters and
// a `javascript:` link is shown as plain text.

const INLINE = /\*\*([^*\n]+?)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+)/gu;
const BULLET = /^\s*[-*•]\s+(.*)$/u;
const ORDERED = /^\s*\d{1,3}[.)]\s+(.*)$/u;

// Own domain: a path from the root, or the same origin over http(s). Anything else is not a link.
export function ownUrl(url, origin) {
  if (/^\/(?![/\\])/.test(url)) return url;
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === origin ? u.href : null;
  } catch {
    return null;
  }
}

function inline(parent, text, doc, origin) {
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) parent.append(doc.createTextNode(text.slice(last, m.index)));
    last = m.index + m[0].length;
    if (m[1] != null) {
      const b = doc.createElement('strong');
      b.textContent = m[1];
      parent.append(b);
    } else {
      const [label, raw] = m[2] != null ? [m[2], m[3]] : [m[4].replace(/[.,;:!?]+$/, ''), m[4].replace(/[.,;:!?]+$/, '')];
      if (m[2] == null && m[4].length > raw.length) last -= m[4].length - raw.length;   // the closing dot is not part of the address
      const href = ownUrl(raw, origin);
      if (href) {
        const a = doc.createElement('a');
        a.href = href;
        a.textContent = label;
        a.rel = 'noopener noreferrer';
        parent.append(a);
      } else {
        parent.append(doc.createTextNode(m[2] != null ? `${label} (${raw})` : label));   // a foreign link is only text
      }
    }
  }
  if (last < text.length) parent.append(doc.createTextNode(text.slice(last)));
}

// → a DocumentFragment: <p>, <ul>, <ol>. doc, origin — injectable (node tests use linkedom).
export function renderMarkdown(text, { doc = document, origin = typeof location === 'undefined' ? '' : location.origin } = {}) {
  const frag = doc.createDocumentFragment();
  let list = null;      // { el, ordered }
  let para = null;
  const closeAll = () => { list = null; para = null; };
  for (const line of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.trim()) { closeAll(); continue; }
    const b = BULLET.exec(line), o = b ? null : ORDERED.exec(line);
    if (b || o) {
      para = null;
      const ordered = !!o;
      if (!list || list.ordered !== ordered) {
        list = { el: doc.createElement(ordered ? 'ol' : 'ul'), ordered };
        frag.append(list.el);
      }
      const li = doc.createElement('li');
      inline(li, (b ?? o)[1], doc, origin);
      list.el.append(li);
      continue;
    }
    list = null;
    if (!para) { para = doc.createElement('p'); frag.append(para); } else para.append(doc.createElement('br'));
    inline(para, line, doc, origin);
  }
  return frag;
}
