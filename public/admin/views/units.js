// The chessboard (12 §3, FR-ADM-03): floors × apartments in the colours of the showcase, filters, a card of the picked apartment
// on the right. Polls GET /api/admin/units every 5 s while the tab is visible (the same request wakes the job tick, 04 §5).
// Changes (booking actions, sale, shift) are D4-03 / D4-05; here the card reads.
import { api, ApiError } from '../api.js';
import { el, toast, money, dateTime, left } from '../ui.js';
import { t, addTexts } from '../i18n.js';
import { shiftBlock } from './shift.js';

addTexts({
  ru: { 'apt.openBooking': 'Открыть бронь', 'apt.client': 'Клиент', 'apt.term': 'Срок', 'apt.soldLabel': 'Продана', 'ev.booking.held': 'Удержание начато', 'ev.booking.hold_expired': 'Удержание истекло', 'ev.booking.paid': 'Депозит оплачен',
    'ev.booking.extended': 'Бронь продлена', 'ev.booking.extend_requested': 'Клиент просит продлить', 'ev.booking.expired': 'Бронь сгорела',
    'ev.booking.cancelled': 'Бронь отменена', 'ev.booking.released': 'Клиент снял удержание', 'ev.apartment.sold': 'Квартира продана',
    'ev.apartment.unsold': 'Продажа отменена', 'ev.payment.started': 'Оплата начата', 'ev.payment.succeeded': 'Оплата прошла',
    'ev.payment.failed': 'Оплата не прошла', 'ev.payment.cancelled': 'Оплата отменена', 'ev.payment.late': 'Оплата после срока',
    'ev.refund.requested': 'Возврат запрошен', 'ev.refund.succeeded': 'Возврат выполнен', 'ev.refund.failed': 'Возврат не удался',
    'ev.viewing.created': 'Запись на показ', 'ev.demo.time_shifted': 'Демо: срок сдвинут' },
  en: { 'apt.openBooking': 'Open the booking', 'apt.client': 'Client', 'apt.term': 'Deadline', 'apt.soldLabel': 'Sold', 'ev.booking.held': 'Hold started', 'ev.booking.hold_expired': 'Hold expired', 'ev.booking.paid': 'Deposit paid',
    'ev.booking.extended': 'Booking extended', 'ev.booking.extend_requested': 'Client asks to extend', 'ev.booking.expired': 'Booking expired',
    'ev.booking.cancelled': 'Booking cancelled', 'ev.booking.released': 'Client released the hold', 'ev.apartment.sold': 'Apartment sold',
    'ev.apartment.unsold': 'Sale undone', 'ev.payment.started': 'Payment started', 'ev.payment.succeeded': 'Payment succeeded',
    'ev.payment.failed': 'Payment failed', 'ev.payment.cancelled': 'Payment cancelled', 'ev.payment.late': 'Payment after the deadline',
    'ev.refund.requested': 'Refund requested', 'ev.refund.succeeded': 'Refund done', 'ev.refund.failed': 'Refund failed',
    'ev.viewing.created': 'Viewing booked', 'ev.demo.time_shifted': 'Demo: deadline shifted' },
  uz: { 'apt.openBooking': 'Bronni ochish', 'apt.client': 'Mijoz', 'apt.term': 'Muddat', 'apt.soldLabel': 'Sotilgan', 'ev.booking.held': 'Ushlab turish boshlandi', 'ev.booking.hold_expired': 'Ushlab turish tugadi', 'ev.booking.paid': 'Depozit to‘landi',
    'ev.booking.extended': 'Bron uzaytirildi', 'ev.booking.extend_requested': 'Mijoz uzaytirishni so‘ramoqda', 'ev.booking.expired': 'Bron muddati tugadi',
    'ev.booking.cancelled': 'Bron bekor qilindi', 'ev.booking.released': 'Mijoz ushlab turishni bekor qildi', 'ev.apartment.sold': 'Kvartira sotildi',
    'ev.apartment.unsold': 'Sotuv bekor qilindi', 'ev.payment.started': 'To‘lov boshlandi', 'ev.payment.succeeded': 'To‘lov o‘tdi',
    'ev.payment.failed': 'To‘lov o‘tmadi', 'ev.payment.cancelled': 'To‘lov bekor qilindi', 'ev.payment.late': 'Muddatdan keyingi to‘lov',
    'ev.refund.requested': 'Qaytarish so‘raldi', 'ev.refund.succeeded': 'Qaytarish bajarildi', 'ev.refund.failed': 'Qaytarish bajarilmadi',
    'ev.viewing.created': 'Ko‘rishga yozildi', 'ev.demo.time_shifted': 'Demo: muddat siljitildi' }
});

const POLL_MS = 5000;
const STATUSES = ['free', 'held', 'booked', 'sold'];

export const evLabel = type => { const s = t('ev.' + type); return s === 'ev.' + type ? type : s; };
export const roomsLabel = n => (n === 0 ? t('units.studio') : t('units.roomsN', { n }));

export function mount(root, { staff, params }) {
  const filter = { status: new Set(), rooms: '', floor: '', soon: false };
  let units = [], offset = 0, updatedAt = null, failed = false;
  let selected = Number(params[0]) || null, card = null, cardSig = '', cardToken = 0;
  let timer = null, dead = false;

  const filters = el('div', { class: 'adm2-filters' });
  const info = el('p', { class: 'adm2-muted adm2-info' });
  const board = el('div', { class: 'adm2-board' });
  const side = el('aside', { class: 'adm2-side', hidden: true });
  root.replaceChildren(el('h1', { class: 'adm2-h1' }, t('units.title')), filters, info, el('div', { class: 'adm2-split' }, board, side));

  const nowMs = () => Date.now() + offset;
  const matches = u => (!filter.status.size || filter.status.has(u.status))
    && (filter.rooms === '' || u.rooms === Number(filter.rooms))
    && (filter.floor === '' || u.floor === Number(filter.floor))
    && (!filter.soon || u.soon);

  function drawFilters() {
    const rooms = [...new Set(units.map(u => u.rooms))].sort((a, b) => a - b);
    const floors = [...new Set(units.map(u => u.floor))].sort((a, b) => a - b);
    const select = (key, label, values, text) => el('label', { class: 'adm2-sel' }, el('span', {}, label),
      el('select', { on: { change: e => { filter[key] = e.target.value; draw(); } } },
        el('option', { value: '' }, t('units.all')),
        values.map(v => el('option', { value: String(v), selected: String(v) === String(filter[key]) }, text(v)))));
    filters.replaceChildren(
      el('div', { class: 'adm2-chips', role: 'group', 'aria-label': t('units.status') },
        STATUSES.map(s => el('button', { type: 'button', class: `adm2-chip st-${s}` + (filter.status.has(s) ? ' on' : ''), 'aria-pressed': String(filter.status.has(s)),
          on: { click: () => { filter.status.has(s) ? filter.status.delete(s) : filter.status.add(s); draw(); } } }, t('st.' + s)))),
      select('rooms', t('units.rooms'), rooms, roomsLabel),
      select('floor', t('units.floor'), floors, v => t('units.floorN', { n: v })),
      el('button', { type: 'button', class: 'adm2-chip soon' + (filter.soon ? ' on' : ''), 'aria-pressed': String(filter.soon),
        on: { click: () => { filter.soon = !filter.soon; draw(); } } }, t('units.soon')),
      el('button', { type: 'button', class: 'btn ghost sm', on: { click: () => { filter.status.clear(); filter.rooms = ''; filter.floor = ''; filter.soon = false; draw(); } } }, t('units.reset')));
  }

  function cell(u) {
    const time = u.expiresAt ? left(new Date(u.expiresAt).getTime() - nowMs()) : null;
    return el('button', {
      type: 'button', class: `adm2-cell st-${u.status}` + (u.soon ? ' soon' : '') + (matches(u) ? '' : ' dim') + (u.no === selected ? ' sel' : ''),
      title: `№${u.no} · ${roomsLabel(u.rooms)} · ${t('apt.areaV', { n: u.area })} · ${money(u.price)}`,
      'aria-label': `№${u.no}, ${t('st.' + u.status)}`, dataset: { no: u.no }, on: { click: () => pick(u.no) }
    }, el('b', {}, String(u.no)), el('small', {}, u.rooms === 0 ? 'ст' : `${u.rooms}к`), time && el('em', {}, time));
  }

  function draw() {
    drawFilters();
    const floors = [...new Set(units.map(u => u.floor))].sort((a, b) => b - a)
      .filter(fl => filter.floor === '' || fl === Number(filter.floor));
    board.replaceChildren(...(units.length ? floors.map(fl => el('div', { class: 'adm2-floor' },
      el('span', { class: 'adm2-floor-n' }, t('units.floorLabel', { n: fl })),
      el('div', { class: 'adm2-cells' }, units.filter(u => u.floor === fl).map(cell)))) : [el('p', { class: 'adm2-empty' }, t('units.empty'))]));
    const shown = units.filter(matches).length;
    info.textContent = [t('units.count', { n: shown, all: units.length }), updatedAt && t('units.updated', { time: dateTime(updatedAt) }), t('units.legend'),
      failed && t('app.fail')].filter(Boolean).join(' · ');
  }

  // ---- the card ----
  const row = (k, v) => el('div', { class: 'adm2-kv' }, el('span', {}, k), el('b', {}, v));
  function bookingBlock(b) {
    const ms = new Date(b.expiresAt).getTime() - nowMs();
    const rest = left(ms);
    return el('div', { class: 'adm2-booking' },
      el('div', { class: 'adm2-booking-head' }, el('b', {}, `№${b.no}`), el('span', { class: `adm2-badge bk-${b.status}` }, t('bk.' + b.status))),
      row(t('apt.client'), `${b.client.name || '—'} · ${b.client.phone || '—'}`),
      row('Telegram', b.client.telegramLinked ? t('apt.tgLinked') : t('apt.noTg')),
      row(t('apt.deposit'), money(b.deposit)),
      row(t('apt.term'), `${dateTime(b.expiresAt)} · ${rest ? t('apt.leftOf', { left: rest }) : t('apt.overdue')}`),
      el('a', { class: 'adm2-link', href: `#/bookings/${b.no}` }, t('apt.openBooking')));
  }
  function bookingRow(b) {
    return el('li', {}, el('b', {}, `№${b.no}`), ' ', el('span', { class: `adm2-badge bk-${b.status}` }, t('bk.' + b.status)), ' ',
      el('span', { class: 'adm2-muted' }, `${b.client.name || '—'} · ${t('ch.' + b.channel)} · ${dateTime(b.heldAt)}`),
      b.cancelInitiator && el('div', { class: 'adm2-muted' }, `${t('apt.cancelBy.' + b.cancelInitiator)}${b.cancelReason ? ' — ' + t('apt.reason', { text: b.cancelReason }) : ''}`));
  }
  const viewingRow = v => el('li', {}, dateTime(v.at), ' ', el('span', { class: 'adm2-badge' }, t('vw.' + v.status)), ' ',
    el('span', { class: 'adm2-muted' }, `${v.name} · ${v.phone} · ${t('ch.' + v.channel)}`));
  const eventRow = e => el('li', {}, el('span', { class: 'adm2-muted' }, dateTime(e.at)), ' ', evLabel(e.type),
    e.bookingNo && el('span', { class: 'adm2-muted' }, ` · №${e.bookingNo}`), ' ',
    el('span', { class: 'adm2-muted' }, `(${e.actor === 'staff' && e.staff ? e.staff : t('actor.' + e.actor)})`));
  const section = (title, items) => el('section', { class: 'adm2-sec' }, el('h3', {}, title),
    items.length ? el('ul', { class: 'adm2-list' }, items) : el('p', { class: 'adm2-muted' }, t('apt.none')));

  function drawCard() {
    if (selected == null) { side.hidden = true; document.body.classList.remove('adm2-card-open'); return; }
    side.hidden = false;
    document.body.classList.add('adm2-card-open');
    if (!card) { side.replaceChildren(el('p', { class: 'adm2-muted' }, t('app.loading'))); return; }
    const a = card.apartment;
    side.replaceChildren(
      el('div', { class: 'adm2-side-head' },
        el('h2', {}, t('apt.title', { no: a.no })),
        el('span', { class: `adm2-badge st-${a.status}` }, t('st.' + a.status)),
        el('button', { type: 'button', class: 'btn ghost sm', 'aria-label': t('apt.close'), on: { click: () => pick(null) } }, '✕')),
      el('div', { class: 'adm2-facts' },
        row(t('apt.rooms'), roomsLabel(a.rooms)), row(t('apt.area'), t('apt.areaV', { n: a.area })),
        row(t('apt.floor'), String(a.floor)), row(t('apt.price'), money(a.price)),
        a.soldAt && row(t('apt.soldLabel'), dateTime(a.soldAt)),
        a.soldNote && el('p', { class: 'adm2-muted' }, t('apt.soldNote', { note: a.soldNote }))),
      el('section', { class: 'adm2-sec' }, el('h3', {}, t('apt.current')),
        card.booking ? bookingBlock(card.booking) : el('p', { class: 'adm2-muted' }, t('apt.noCurrent'))),
      staff?.role === 'head' && card.booking && shiftBlock(card.booking, () => { cardSig = ''; return poll(); }),
      section(t('apt.bookings'), card.bookings.map(bookingRow)),
      section(t('apt.viewings'), card.viewings.map(viewingRow)),
      section(t('apt.history'), card.history.map(eventRow)));
  }

  async function loadCard() {
    if (selected == null) return;
    const mine = ++cardToken, no = selected;
    try {
      const c = await api(`/api/admin/apartments/${no}`);
      if (dead || mine !== cardToken) return;
      const sig = JSON.stringify({ ...c, at: 0 }) + (c.booking ? left(new Date(c.booking.expiresAt).getTime() - nowMs()) : '');
      card = c;
      if (sig !== cardSig) { cardSig = sig; drawCard(); }
    } catch (ex) {
      if (dead || mine !== cardToken || (ex instanceof ApiError && ex.status === 401)) return;
      card = null;
      side.replaceChildren(el('p', { class: 'adm2-err' }, ex instanceof ApiError && ex.status === 404 ? ex.message : t('apt.loadFail')));
    }
  }

  function pick(no) {
    selected = selected === no ? null : no;
    card = null; cardSig = ''; cardToken++;
    history.replaceState(null, '', '#/units' + (selected ? '/' + selected : ''));
    draw(); drawCard(); loadCard();
  }

  async function poll() {
    if (dead) return;
    try {
      const r = await api('/api/admin/units');
      if (dead) return;
      units = r.units; offset = new Date(r.at).getTime() - Date.now(); updatedAt = r.at; failed = false;
      draw();
    } catch (ex) {
      if (dead || (ex instanceof ApiError && ex.status === 401)) return;
      if (!failed) toast(t('app.fail'), true);
      failed = true; info.textContent = t('app.fail');
    }
    loadCard();
  }
  const schedule = () => { clearInterval(timer); timer = setInterval(() => { if (!document.hidden) poll(); }, POLL_MS); };
  const onVisible = () => { if (!document.hidden) poll(); };
  document.addEventListener('visibilitychange', onVisible);

  draw(); drawCard();
  poll(); schedule();
  return () => { dead = true; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); document.body.classList.remove('adm2-card-open'); };
}
