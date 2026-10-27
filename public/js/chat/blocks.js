// The blocks of an answer (11 §3.3, §5.4): apartment cards, the installment table, the confirmation card, the buttons.
// Everything is built with createElement / textContent — a text from a model or a tool never becomes HTML.
import { groupNum } from '../bkFormat.js';
import { ownUrl } from './markdown.js';

const el = (doc, tag, cls, text) => {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const btn = (doc, cls, text, onClick) => {
  const b = el(doc, 'button', cls, text);
  b.type = 'button';
  if (onClick) b.addEventListener('click', onClick);
  return b;
};
const num = n => groupNum(Math.round(Number(n) || 0));

// ctx — { t(key, vars), doc, origin, onOpen(no, { book }), onSuggest(s), onConfirm(button, data), onFlyTo? }
export function renderBlock(block, ctx) {
  const d = block?.data ?? {};
  switch (block?.type) {
    case 'apartments': return apartments(d.items ?? [], ctx);
    case 'table': return table(d, ctx);
    case 'confirm': return confirm(d, ctx);
    case 'suggestions': return suggestions(d, ctx);
    default: return null;     // 'press' and the unknown kinds are not drawn
  }
}

function apartments(items, { t, doc, onOpen }) {
  const box = el(doc, 'div', 'chat-cards');
  for (const a of items.slice(0, 3)) {
    const card = el(doc, 'div', 'chat-apt');
    const head = el(doc, 'div', 'chat-apt-head');
    head.append(el(doc, 'strong', null, t('chat.apt', { no: a.no })), el(doc, 'span', `chat-state ${a.status ?? ''}`, t(`chat.state.${a.status ?? 'free'}`)));
    card.append(head,
      el(doc, 'div', 'chat-apt-line', t('chat.aptLine', { rooms: a.rooms === 0 ? 'S' : a.rooms, area: String(a.area).replace('.', ','), floor: a.floor })),
      el(doc, 'div', 'chat-apt-price', t('chat.price', { price: num(a.price) })));
    const row = el(doc, 'div', 'chat-row');
    row.append(btn(doc, 'chat-btn', t('chat.open3d'), () => onOpen(a.no, { book: false })));
    if (a.status === 'free') row.append(btn(doc, 'chat-btn primary', t('chat.book'), () => onOpen(a.no, { book: true })));
    card.append(row);
    box.append(card);
  }
  return box;
}

function table(d, { t, doc }) {
  const wrap = el(doc, 'div', 'chat-table-wrap');
  const tbl = el(doc, 'table', 'chat-table');
  const mortgage = (d.rows ?? []).some(r => r.kind === 'mortgage');
  const cols = mortgage ? ['kind', 'term', 'down', 'monthly', 'over'] : ['term', 'down', 'monthly', 'over'];
  const head = el(doc, 'tr');
  for (const c of cols) head.append(el(doc, 'th', null, t(`chat.t.${c}`)));
  tbl.append(head);
  const rows = d.rows ?? (d.plans ?? []).map(p => ({ kind: 'installment', months: p.months, down: p.down, monthly: p.monthly, overpay: p.markup }));
  for (const r of rows) {
    const tr = el(doc, 'tr');
    const cell = {
      kind: t(`chat.t.${r.kind}`),
      term: t('chat.t.months', { n: r.months }),
      down: num(r.down),
      monthly: num(r.monthly),
      over: r.overpay == null ? '—' : num(r.overpay)
    };
    for (const c of cols) tr.append(el(doc, 'td', null, cell[c]));
    tbl.append(tr);
  }
  wrap.append(tbl);
  if (d.price) wrap.append(el(doc, 'div', 'chat-table-foot', t('chat.t.price', { price: num(d.price) })));
  return wrap;
}

// The card of a draft: the terms are the server's words (07 §8.2), drawn as they are. After an answer the buttons go off.
function confirm(d, { t, doc, onConfirm }) {
  const card = el(doc, 'div', 'chat-confirm');
  card.dataset.pending = d.pendingActionId;
  card.append(el(doc, 'strong', 'chat-confirm-title', d.title));
  const ul = el(doc, 'ul');
  for (const l of d.lines ?? []) ul.append(el(doc, 'li', null, l));
  card.append(ul);
  const row = el(doc, 'div', 'chat-row');
  for (const b of d.buttons ?? []) {
    const x = btn(doc, b.action === 'yes' ? 'chat-btn primary' : 'chat-btn', b.label, () => {
      for (const y of row.querySelectorAll('button')) y.disabled = true;
      onConfirm(b, d, card);
    });
    row.append(x);
  }
  card.append(row);
  return card;
}

// Quick answers: a button with an intent (or the words to say), or a link — only to our own domain.
function suggestions(list, { t, doc, origin, onSuggest }) {
  const row = el(doc, 'div', 'chat-sg');
  for (const s of Array.isArray(list) ? list : []) {
    if (s.url) {
      const href = ownUrl(s.url, origin);
      if (!href) continue;
      const a = el(doc, 'a', 'chat-chip', s.label);
      a.href = href;
      a.rel = 'noopener noreferrer';
      row.append(a);
    } else if (s.action && s.data) {
      row.append(btn(doc, 'chat-chip', s.label, () => onSuggest({ ...s, callback: true })));
    } else {
      row.append(btn(doc, 'chat-chip', s.label, () => onSuggest(s)));
    }
  }
  return row.childElementCount ? row : null;
}

// The contact form of the «leave a phone» button (13 §6.1): the number goes to the server as an intent, not as a message to a model.
export function phoneForm({ t, doc, onSend }) {
  const form = el(doc, 'form', 'chat-phone');
  form.noValidate = true;
  form.append(el(doc, 'strong', null, t('chat.phone.title')));
  const name = el(doc, 'input');
  name.name = 'name'; name.maxLength = 60; name.autocomplete = 'name'; name.placeholder = t('chat.phone.name');
  const phone = el(doc, 'input');
  phone.name = 'phone'; phone.type = 'tel'; phone.required = true; phone.maxLength = 30; phone.autocomplete = 'tel'; phone.placeholder = '+998 __ ___ __ __';
  const err = el(doc, 'div', 'chat-err');
  err.setAttribute('role', 'alert');
  const go = el(doc, 'button', 'chat-btn primary', t('chat.phone.send'));
  go.type = 'submit';
  form.append(name, phone, err, go);
  form.addEventListener('submit', e => {
    e.preventDefault();
    const digits = phone.value.replace(/\D/g, '');
    if (digits.length < 9 || digits.length > 15) { err.textContent = t('chat.phone.invalid'); return; }
    if (name.value.trim().length === 1) { err.textContent = t('chat.phone.name.invalid'); return; }
    go.disabled = true;
    onSend({ name: name.value.trim() || undefined, phone: phone.value.trim() });
  });
  return form;
}
