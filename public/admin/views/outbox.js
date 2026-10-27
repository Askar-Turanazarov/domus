// Outbox (12 §6, 04 §3.3, FR-DEMO-02, NFR-OBS-04), head only: the last 200 outgoing messages with their fate, a preview as the bot sent it
// (a Telegram-style bubble, buttons under it) and «send again» for a failed row. Links of a booking arrive already masked. Refreshes every 3 s.
import { api, ApiError } from '../api.js';
import { el, toast, dateTime } from '../ui.js';
import { t, addTexts } from '../i18n.js';
import { label } from './common.js';

addTexts({
  ru: { 'nav.outbox': 'Outbox', 'obx.title': 'Исходящие сообщения', 'obx.status': 'Статус', 'obx.target': 'Кому', 'obx.template': 'Шаблон', 'obx.reset': 'Сбросить',
    'obx.col.time': 'Время', 'obx.col.to': 'Кому', 'obx.col.template': 'Шаблон', 'obx.col.status': 'Статус', 'obx.col.tries': 'Попытки',
    'obx.st.pending': 'В очереди', 'obx.st.sending': 'Отправляется', 'obx.st.sent': 'Отправлено', 'obx.st.retry': 'Повтор', 'obx.st.failed': 'Не доставлено', 'obx.st.skipped': 'Пропущено', 'obx.st.cancelled': 'Отменено',
    'obx.to.client': 'Клиент', 'obx.to.staff_group': 'Группа менеджеров', 'obx.to.staff': 'Сотрудник', 'obx.skip.no_telegram': 'нет Telegram', 'obx.skip.blocked': 'бот заблокирован', 'obx.skip.disabled': 'отправка выключена',
    'obx.card': 'Сообщение №{id}', 'obx.sentAt': 'Отправлено', 'obx.nextAt': 'Следующая попытка', 'obx.error': 'Ошибка', 'obx.event': 'Событие', 'obx.booking': 'Бронь №{no}', 'obx.lang': 'Язык',
    'obx.attach': 'Вложение: {kind}', 'obx.noPreview': 'Предпросмотра нет', 'obx.resend': 'Отправить снова', 'obx.resent': 'Поставлено в очередь', 'obx.cantResend': 'Это сообщение уже нельзя отправить снова',
    'obx.loadFail': 'Не удалось загрузить сообщение', 'obx.notFound': 'Такого сообщения нет', 'obx.found': 'Показано {n}', 'obx.group': 'Группа', 'obx.btn.web_app': 'откроет мини-приложение', 'obx.btn.link': 'ссылка', 'obx.btn.action': 'действие' },
  en: { 'nav.outbox': 'Outbox', 'obx.title': 'Outgoing messages', 'obx.status': 'Status', 'obx.target': 'To', 'obx.template': 'Template', 'obx.reset': 'Reset',
    'obx.col.time': 'Time', 'obx.col.to': 'To', 'obx.col.template': 'Template', 'obx.col.status': 'Status', 'obx.col.tries': 'Tries',
    'obx.st.pending': 'Queued', 'obx.st.sending': 'Sending', 'obx.st.sent': 'Sent', 'obx.st.retry': 'Retrying', 'obx.st.failed': 'Not delivered', 'obx.st.skipped': 'Skipped', 'obx.st.cancelled': 'Cancelled',
    'obx.to.client': 'Client', 'obx.to.staff_group': 'Managers group', 'obx.to.staff': 'Staff member', 'obx.skip.no_telegram': 'no Telegram', 'obx.skip.blocked': 'bot blocked', 'obx.skip.disabled': 'sending is off',
    'obx.card': 'Message {id}', 'obx.sentAt': 'Sent', 'obx.nextAt': 'Next attempt', 'obx.error': 'Error', 'obx.event': 'Event', 'obx.booking': 'Booking {no}', 'obx.lang': 'Language',
    'obx.attach': 'Attachment: {kind}', 'obx.noPreview': 'No preview', 'obx.resend': 'Send again', 'obx.resent': 'Queued', 'obx.cantResend': 'This message can no longer be sent again',
    'obx.loadFail': 'Could not load the message', 'obx.notFound': 'No such message', 'obx.found': 'Shown: {n}', 'obx.group': 'Group', 'obx.btn.web_app': 'opens the mini app', 'obx.btn.link': 'link', 'obx.btn.action': 'action' },
  uz: { 'nav.outbox': 'Outbox', 'obx.title': 'Chiquvchi xabarlar', 'obx.status': 'Holat', 'obx.target': 'Kimga', 'obx.template': 'Shablon', 'obx.reset': 'Tozalash',
    'obx.col.time': 'Vaqt', 'obx.col.to': 'Kimga', 'obx.col.template': 'Shablon', 'obx.col.status': 'Holat', 'obx.col.tries': 'Urinishlar',
    'obx.st.pending': 'Navbatda', 'obx.st.sending': 'Yuborilmoqda', 'obx.st.sent': 'Yuborilgan', 'obx.st.retry': 'Qayta urinish', 'obx.st.failed': 'Yetkazilmadi', 'obx.st.skipped': 'O‘tkazib yuborilgan', 'obx.st.cancelled': 'Bekor qilingan',
    'obx.to.client': 'Mijoz', 'obx.to.staff_group': 'Menejerlar guruhi', 'obx.to.staff': 'Xodim', 'obx.skip.no_telegram': 'Telegram yo‘q', 'obx.skip.blocked': 'bot bloklangan', 'obx.skip.disabled': 'yuborish o‘chirilgan',
    'obx.card': '{id}-xabar', 'obx.sentAt': 'Yuborilgan', 'obx.nextAt': 'Keyingi urinish', 'obx.error': 'Xato', 'obx.event': 'Hodisa', 'obx.booking': '{no}-bron', 'obx.lang': 'Til',
    'obx.attach': 'Ilova: {kind}', 'obx.noPreview': 'Ko‘rinish yo‘q', 'obx.resend': 'Qayta yuborish', 'obx.resent': 'Navbatga qo‘yildi', 'obx.cantResend': 'Bu xabarni qayta yuborib bo‘lmaydi',
    'obx.loadFail': 'Xabarni yuklab bo‘lmadi', 'obx.notFound': 'Bunday xabar yo‘q', 'obx.found': 'Ko‘rsatilgan: {n}', 'obx.group': 'Guruh', 'obx.btn.web_app': 'mini ilovani ochadi', 'obx.btn.link': 'havola', 'obx.btn.action': 'harakat' }
});

const POLL_MS = 3000;
const STATUSES = ['pending', 'sending', 'sent', 'retry', 'failed', 'skipped', 'cancelled'];
const TARGETS = ['client', 'staff_group', 'staff_dm'];
const TARGET_LABEL = { client: 'obx.to.client', staff_group: 'obx.to.staff_group', staff_dm: 'obx.to.staff' };

const ENTITIES = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': '\'' };
const decode = s => s.replace(/&(?:lt|gt|amp|quot|#39);/g, m => ENTITIES[m]);
const TAG = /<(\/?)(b|i|u|s|code|pre|a)(?:\s+href="([^"]*)")?\s*>/gi;

// The bot's HTML (b, i, u, s, code, pre, a) as DOM nodes built by hand: anything else stays as plain text, a link keeps only http(s).
export function bubbleNodes(html) {
  const root = el('div', { class: 'adm2-bubble-text' });
  const stack = [root];
  let last = 0;
  const top = () => stack[stack.length - 1];
  for (const m of String(html ?? '').matchAll(TAG)) {
    if (m.index > last) top().append(document.createTextNode(decode(html.slice(last, m.index))));
    last = m.index + m[0].length;
    const name = m[2].toLowerCase();
    if (m[1]) {
      if (stack.length > 1 && top().localName === name) stack.pop();
    } else {
      const node = document.createElement(name);
      if (name === 'a') {
        const href = decode(m[3] ?? '');
        if (/^https?:\/\//i.test(href)) { node.setAttribute('href', href); node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
      }
      top().append(node);
      stack.push(node);
    }
  }
  if (last < String(html ?? '').length) top().append(document.createTextNode(decode(html.slice(last))));
  return root;
}

const statusBadge = status => el('span', { class: `adm2-badge ob-${status}` }, label('obx.st.', status));
const recipientOf = r => (r.kind === 'client' ? (r.name || t('obx.to.client')) : r.kind === 'staff' ? (r.name || t('obx.to.staff')) : t('obx.to.staff_group'));
const withSkip = r => (r.skipReason ? `${label('obx.st.', r.status)}: ${label('obx.skip.', r.skipReason)}` : label('obx.st.', r.status));

export function mount(root, { params }) {
  const F = { status: '', target: '', template: '' };
  const S = { items: [], loaded: false, failed: false };
  let selected = params[0] || null, card = null, cardSig = '', cardToken = 0, listToken = 0, timer = null, dead = false;

  const filters = el('div', { class: 'adm2-filters' });
  const info = el('p', { class: 'adm2-muted adm2-info' });
  const list = el('div', { class: 'adm2-tablewrap' });
  const total = el('p', { class: 'adm2-total' });
  const side = el('aside', { class: 'adm2-side', hidden: true });
  root.replaceChildren(el('h1', { class: 'adm2-h1' }, t('obx.title')), filters, info, el('div', { class: 'adm2-split list' }, el('div', {}, list, total), side));

  const reload = () => { S.items = []; S.loaded = false; load(); drawList(); };
  function drawFilters() {
    const select = (key, caption, values, text) => el('label', { class: 'adm2-sel' }, el('span', {}, caption),
      el('select', { name: key, on: { change: e => { F[key] = e.target.value; reload(); } } },
        el('option', { value: '' }, t('units.all')), values.map(v => el('option', { value: v, selected: v === F[key] }, text(v)))));
    filters.replaceChildren(select('status', t('obx.status'), STATUSES, v => label('obx.st.', v)),
      select('target', t('obx.target'), TARGETS, v => t(TARGET_LABEL[v])),
      el('label', { class: 'adm2-sel' }, el('span', {}, t('obx.template')),
        el('input', { type: 'text', name: 'template', value: F.template, maxLength: 60, on: { change: e => { F.template = e.target.value.trim(); reload(); } } })),
      el('button', { type: 'button', class: 'btn ghost sm', on: { click: () => { Object.keys(F).forEach(k => { F[k] = ''; }); drawFilters(); reload(); } } }, t('obx.reset')));
  }

  function row(m) {
    return el('tr', { class: String(m.id) === String(selected) ? 'sel' : '', tabindex: 0, dataset: { id: m.id },
      on: { click: () => pick(m.id), keydown: e => { if (e.key === 'Enter') pick(m.id); } } },
    el('td', {}, dateTime(m.createdAt)),
    el('td', {}, recipientOf(m.recipient)),
    el('td', {}, el('code', {}, m.template)),
    el('td', {}, statusBadge(m.status), m.skipReason && el('small', {}, label('obx.skip.', m.skipReason))),
    el('td', {}, String(m.attempts)));
  }

  function drawList() {
    const head = ['time', 'to', 'template', 'status', 'tries'].map(c => el('th', {}, t('obx.col.' + c)));
    list.replaceChildren(S.items.length
      ? el('table', { class: 'adm2-table' }, el('thead', {}, el('tr', {}, head)), el('tbody', {}, S.items.map(row)))
      : el('p', { class: 'adm2-empty' }, S.loaded ? t('list.empty') : t('app.loading')));
    total.textContent = S.loaded ? t('obx.found', { n: S.items.length }) : '';
    info.textContent = S.failed ? t('app.fail') : '';
  }

  async function load() {
    const mine = ++listToken;
    const qs = new URLSearchParams(Object.entries(F).filter(([, v]) => v));
    qs.set('limit', '200');
    try {
      const r = await api(`/api/admin/outbox?${qs}`);
      if (dead || mine !== listToken) return;
      S.items = r.items; S.loaded = true; S.failed = false;
    } catch (ex) {
      if (dead || mine !== listToken || (ex instanceof ApiError && ex.status === 401)) return;
      if (!S.failed) toast(t('app.fail'), true);
      S.failed = true;
    }
    drawList();
  }

  // ---- the card: the message as the person saw it ----
  const kv = (k, v) => el('div', { class: 'adm2-kv' }, el('span', {}, k), el('b', {}, v));
  function bubble(m) {
    if (!m.preview) return el('p', { class: 'adm2-muted' }, t('obx.noPreview'));
    return el('div', { class: 'adm2-chat' },
      el('div', { class: 'adm2-bubble', dataset: { part: 'bubble' } }, bubbleNodes(m.preview.html), m.attachment && el('div', { class: 'adm2-attach' }, '📎 ', t('obx.attach', { kind: m.attachment }))),
      m.preview.buttons.length > 0 && el('div', { class: 'adm2-tgbuttons' }, m.preview.buttons.map(b =>
        el('span', { class: `adm2-tgbtn ${b.kind}`, title: b.target ?? label('obx.btn.', b.kind) }, b.text))));
  }

  function drawCard() {
    if (selected == null) { side.hidden = true; document.body.classList.remove('adm2-card-open'); return; }
    side.hidden = false;
    document.body.classList.add('adm2-card-open');
    if (!card) { side.replaceChildren(el('p', { class: 'adm2-muted' }, t('app.loading'))); return; }
    const m = card;
    side.replaceChildren(
      el('div', { class: 'adm2-side-head' }, el('h2', {}, t('obx.card', { id: m.id })), statusBadge(m.status),
        el('button', { type: 'button', class: 'btn ghost sm', 'aria-label': t('apt.close'), on: { click: () => pick(null) } }, '✕')),
      bubble(m),
      el('div', { class: 'adm2-facts' },
        kv(t('obx.col.to'), recipientOf(m.recipient)), kv(t('obx.col.template'), m.template), kv(t('obx.col.status'), withSkip(m)), kv(t('obx.col.tries'), String(m.attempts)),
        kv(t('obx.col.time'), dateTime(m.createdAt)), m.sentAt && kv(t('obx.sentAt'), dateTime(m.sentAt)),
        m.nextAttemptAt && ['pending', 'retry'].includes(m.status) && kv(t('obx.nextAt'), dateTime(m.nextAttemptAt)),
        kv(t('obx.lang'), m.lang), m.event && kv(t('obx.event'), `${m.event.type} · ${dateTime(m.event.at)}`),
        m.lastError && el('p', { class: 'adm2-err' }, `${t('obx.error')}: ${m.lastError}`)),
      el('div', { class: 'adm2-actions' },
        m.bookingNo && el('a', { class: 'btn ghost sm', href: `#/bookings/${m.bookingNo}` }, t('obx.booking', { no: m.bookingNo })),
        m.canResend && el('button', { type: 'button', class: 'btn primary sm', dataset: { act: 'resend' }, on: { click: resend } }, t('obx.resend'))));
  }

  async function loadCard() {
    if (selected == null) return;
    const mine = ++cardToken, id = selected;
    try {
      const c = await api(`/api/admin/outbox/${encodeURIComponent(id)}`);
      if (dead || mine !== cardToken) return;
      const sig = JSON.stringify(c);
      card = c;
      if (sig !== cardSig) { cardSig = sig; drawCard(); }
    } catch (ex) {
      if (dead || mine !== cardToken || (ex instanceof ApiError && ex.status === 401)) return;
      card = null;
      side.replaceChildren(el('p', { class: 'adm2-err' }, ex instanceof ApiError && ex.status === 404 ? t('obx.notFound') : t('obx.loadFail')));
    }
  }

  function pick(id) {
    selected = String(selected) === String(id) ? null : id;
    card = null; cardSig = ''; cardToken++;
    history.replaceState(null, '', '#/outbox' + (selected ? '/' + selected : ''));
    drawList(); drawCard(); loadCard();
  }

  async function resend() {
    try {
      await api(`/api/admin/outbox/${card.id}/resend`, { method: 'POST', body: {} });
      toast(t('obx.resent'));
    } catch (ex) {
      if (ex.code === 'invalid_input') toast(t('obx.cantResend'), true);
      else if (ex.code === 'not_found') toast(t('obx.notFound'), true);
      else toast(ex.message || t('app.fail'), true);
    }
    cardSig = '';
    await Promise.all([load(), loadCard()]);
  }

  const poll = () => { if (!dead) { load(); loadCard(); } };
  const onVisible = () => { if (!document.hidden) poll(); };
  document.addEventListener('visibilitychange', onVisible);
  timer = setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);

  drawFilters(); drawList(); drawCard();
  load(); loadCard();
  return () => { dead = true; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); document.body.classList.remove('adm2-card-open'); };
}
