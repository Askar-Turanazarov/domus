// Requests and furniture orders (12 §12.2, FR-ADM-12, S): number, client, apartment, sum, prepayment and its payment, stage.
// One button moves the stage forward («Дальше: производство», with expectedVersion) — the client gets order_stage_changed;
// «Отменить» — a paid order's prepayment is then refunded by the head by hand from the payment card. Polled every 10 s.
import { api, newKey, ApiError } from '../api.js';
import { el, toast, money, dateTime, askForm } from '../ui.js';
import { t, addTexts } from '../i18n.js';
import { label, payBadge, isStale } from './common.js';

const STAGE_RU = { new: 'новый', accepted: 'принят', production: 'производство', delivery: 'доставка', assembly: 'сборка', done: 'готово',
  in_work: 'в работе', cancelled: 'отменён' };
const STAGE_EN = { new: 'new', accepted: 'accepted', production: 'production', delivery: 'delivery', assembly: 'assembly', done: 'done',
  in_work: 'in work', cancelled: 'cancelled' };
const STAGE_UZ = { new: 'yangi', accepted: 'qabul qilindi', production: 'ishlab chiqarish', delivery: 'yetkazib berish', assembly: 'yig‘ish',
  done: 'tayyor', in_work: 'ishda', cancelled: 'bekor qilindi' };
const stageTexts = m => Object.fromEntries(Object.entries(m).map(([k, v]) => [`ord.st.${k}`, v]));

addTexts({
  ru: { 'nav.orders': 'Заказы', 'ord.title': 'Заявки и заказы мебели', 'ord.empty': 'Заказов пока нет', 'ord.all': 'Все',
    'ord.kind.furniture': 'Мебель', 'ord.kind.apartment_request': 'Заявки на квартиру', 'ord.no': 'Заказ №{no}', 'ord.apt': 'кв. №{no}',
    'ord.booking': 'бронь №{no}', 'ord.estimate': 'Сумма: {sum}', 'ord.prepay': 'Предоплата {sum}', 'ord.prepaid': 'внесена {when}',
    'ord.notPaid': 'не внесена', 'ord.next': 'Дальше: {stage}', 'ord.cancel': 'Отменить', 'ord.cancelAsk': 'Отменить заказ №{no}?',
    'ord.cancelPaid': 'Предоплата внесена: верните её из карточки платежа (руководитель, с причиной).', 'ord.moved': 'Этап: {stage}',
    'ord.stale': 'Заказ уже изменили — список обновлён', 'ord.files': 'Файлы:', 'ord.note': 'Заметка', 'ord.noteSave': 'Сохранить заметку',
    'ord.noteSaved': 'Заметка сохранена', 'ord.more': 'Показать ещё', 'ord.comment': 'Комментарий клиента: {text}', ...stageTexts(STAGE_RU) },
  en: { 'nav.orders': 'Orders', 'ord.title': 'Requests and furniture orders', 'ord.empty': 'No orders yet', 'ord.all': 'All',
    'ord.kind.furniture': 'Furniture', 'ord.kind.apartment_request': 'Apartment requests', 'ord.no': 'Order No. {no}', 'ord.apt': 'apt. {no}',
    'ord.booking': 'booking No. {no}', 'ord.estimate': 'Sum: {sum}', 'ord.prepay': 'Prepayment {sum}', 'ord.prepaid': 'paid {when}',
    'ord.notPaid': 'not paid', 'ord.next': 'Next: {stage}', 'ord.cancel': 'Cancel', 'ord.cancelAsk': 'Cancel order No. {no}?',
    'ord.cancelPaid': 'The prepayment was made: refund it from the payment card (head, with a reason).', 'ord.moved': 'Stage: {stage}',
    'ord.stale': 'The order was changed meanwhile — the list is updated', 'ord.files': 'Files:', 'ord.note': 'Note', 'ord.noteSave': 'Save the note',
    'ord.noteSaved': 'Note saved', 'ord.more': 'Show more', 'ord.comment': 'Client comment: {text}', ...stageTexts(STAGE_EN) },
  uz: { 'nav.orders': 'Buyurtmalar', 'ord.title': 'Arizalar va mebel buyurtmalari', 'ord.empty': 'Hozircha buyurtmalar yo‘q', 'ord.all': 'Hammasi',
    'ord.kind.furniture': 'Mebel', 'ord.kind.apartment_request': 'Kvartiraga arizalar', 'ord.no': '№{no} buyurtma', 'ord.apt': '{no}-kv.',
    'ord.booking': '№{no} bron', 'ord.estimate': 'Summa: {sum}', 'ord.prepay': 'Oldindan to‘lov {sum}', 'ord.prepaid': '{when} kiritildi',
    'ord.notPaid': 'kiritilmagan', 'ord.next': 'Keyingi: {stage}', 'ord.cancel': 'Bekor qilish', 'ord.cancelAsk': '№{no} buyurtmani bekor qilasizmi?',
    'ord.cancelPaid': 'Oldindan to‘lov kiritilgan: uni to‘lov kartasidan qaytaring (rahbar, sababi bilan).', 'ord.moved': 'Bosqich: {stage}',
    'ord.stale': 'Buyurtma allaqachon o‘zgartirilgan — ro‘yxat yangilandi', 'ord.files': 'Fayllar:', 'ord.note': 'Izoh', 'ord.noteSave': 'Izohni saqlash',
    'ord.noteSaved': 'Izoh saqlandi', 'ord.more': 'Yana ko‘rsatish', 'ord.comment': 'Mijoz izohi: {text}', ...stageTexts(STAGE_UZ) }
});

const POLL_MS = 10_000;
const KINDS = ['', 'furniture', 'apartment_request'];

export function mount(root) {
  let items = [], next = null, kind = '', loaded = false, dead = false, token = 0, busy = false;
  const list = el('div', { class: 'adm2-orders' });
  const more = el('div', { class: 'adm2-more' });
  const filter = el('div', { class: 'adm2-filters', role: 'group' });
  root.replaceChildren(el('h1', { class: 'adm2-h1' }, t('ord.title')), filter, list, more);

  function drawFilter() {
    filter.replaceChildren(...KINDS.map(k => el('button', { type: 'button', class: 'btn' + (k === kind ? ' primary' : ''),
      on: { click: () => { kind = k; items = []; next = null; drawFilter(); load(); } } }, k ? t(`ord.kind.${k}`) : t('ord.all'))));
  }

  // The drawing and the 3D picture come with the session cookie: opened as a blob.
  async function openFile(o, name) {
    try {
      const res = await fetch(`/api/admin/orders/${o.id}/${name}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error();
      window.open(URL.createObjectURL(await res.blob()), '_blank', 'noopener');
    } catch { toast(t('app.fail'), true); }
  }

  async function move(o, stage) {
    if (busy) return;
    if (stage === 'cancelled') {
      const ok = await askForm({ title: t('ord.cancelAsk', { no: o.no }), hint: o.prepaidAt ? t('ord.cancelPaid') : null, submit: t('ord.cancel'),
        danger: true, run: async () => true });
      if (!ok) return;
    }
    busy = true;
    try {
      await api(`/api/admin/orders/${o.id}/stage`, { method: 'POST', body: { stage, expectedVersion: o.version }, key: newKey() });
      toast(t('ord.moved', { stage: label('ord.st.', stage) }));
    } catch (ex) {
      toast(isStale(ex) ? t('ord.stale') : ex.message || t('app.fail'), true);
    }
    busy = false;
    load();
  }

  async function saveNote(o, text) {
    try {
      await api(`/api/admin/orders/${o.id}`, { method: 'PATCH', body: { note: text } });
      toast(t('ord.noteSaved'));
    } catch (ex) { toast(ex.message || t('app.fail'), true); }
  }

  function row(o) {
    const money2 = o.prepayAmount != null && el('div', {}, t('ord.prepay', { sum: money(o.prepayAmount) }), ' · ',
      o.prepaidAt ? el('b', {}, t('ord.prepaid', { when: dateTime(o.prepaidAt) })) : el('span', { class: 'adm2-muted' }, t('ord.notPaid')),
      o.payment && !o.prepaidAt ? [' ', payBadge(o.payment.status)] : null);
    const note = el('textarea', { rows: 2, maxLength: 2000, value: o.note ?? '', 'aria-label': t('ord.note') });
    return el('li', { class: 'adm2-order-row', dataset: { no: String(o.no) } },
      el('div', {}, el('b', {}, t('ord.no', { no: o.no })), ' ', el('span', { class: `adm2-badge st-${o.stage}` }, label('ord.st.', o.stage)), ' ',
        el('small', { class: 'adm2-muted' }, `${t(`ord.kind.${o.kind}`)} · ${dateTime(o.createdAt)}`)),
      el('div', {}, el('a', { href: `#/clients/${o.clientId}` }, o.name || '—'), ' ', el('small', { class: 'adm2-muted' }, o.phone || ''),
        o.apartmentNo ? ` · ${t('ord.apt', { no: o.apartmentNo })}` : '', o.bookingNo ? ` · ${t('ord.booking', { no: o.bookingNo })}` : ''),
      o.estimate != null && el('div', {}, t('ord.estimate', { sum: money(o.estimate) })),
      money2,
      o.comment && el('div', { class: 'adm2-msg' }, t('ord.comment', { text: o.comment })),
      o.files.length ? el('div', {}, t('ord.files'), ' ', o.files.map(f => el('button', { type: 'button', class: 'btn ghost',
        on: { click: () => openFile(o, f) } }, f))) : null,
      el('details', {}, el('summary', {}, t('ord.note')), note,
        el('button', { type: 'button', class: 'btn', on: { click: () => saveNote(o, note.value) } }, t('ord.noteSave'))),
      el('div', { class: 'adm2-actions' },
        o.next && el('button', { type: 'button', class: 'btn primary', dataset: { act: 'next' }, on: { click: () => move(o, o.next) } },
          t('ord.next', { stage: label('ord.st.', o.next) })),
        !['done', 'cancelled'].includes(o.stage) && el('button', { type: 'button', class: 'btn ghost danger', dataset: { act: 'cancel' },
          on: { click: () => move(o, 'cancelled') } }, t('ord.cancel'))));
  }

  function draw() {
    // a note being typed is not redrawn under the hand
    if (list.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA') return;
    list.replaceChildren(items.length ? el('ul', { class: 'adm2-list' }, items.map(row))
      : el('p', { class: 'adm2-empty' }, loaded ? t('ord.empty') : t('app.loading')));
    more.replaceChildren(...(next ? [el('button', { type: 'button', class: 'btn', on: { click: () => load(true) } }, t('ord.more'))] : []));
  }

  async function load(append = false) {
    const mine = ++token;
    const qs = new URLSearchParams();
    if (kind) qs.set('kind', kind);
    if (append && next) qs.set('cursor', next);
    else qs.set('limit', String(Math.min(100, Math.max(50, items.length))));
    try {
      const r = await api(`/api/admin/orders?${qs}`);
      if (dead || mine !== token) return;
      items = append ? items.concat(r.items) : r.items;
      next = r.next; loaded = true;
      draw();
    } catch (ex) {
      if (dead || mine !== token || (ex instanceof ApiError && ex.status === 401)) return;
      toast(t('app.fail'), true);
    }
  }

  drawFilter(); draw(); load();
  const timer = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
  return () => { dead = true; clearInterval(timer); };
}
