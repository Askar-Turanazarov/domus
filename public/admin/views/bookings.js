// Bookings (12 §4.1, FR-ADM-04): tabs with counts, search, a table, and the card of the picked booking with its payments, events and
// the actions extend / cancel / copy the personal link. Polls every 5 s while the tab is visible (the same request wakes the job
// tick, 04 §5). Every action sends the version the screen saw: a booking that changed meanwhile answers 409 and the card reloads.
import { api, ApiError, newKey } from '../api.js';
import { el, toast, money, dateTime, left, askForm } from '../ui.js';
import { t, addTexts } from '../i18n.js';
import { evLabel, roomsLabel } from './units.js';
import { label, payBadge, refundBadge, method, isStale } from './common.js';
import { shiftBlock } from './shift.js';

addTexts({
  ru: { 'nav.bookings': 'Брони', 'bks.title': 'Брони', 'bks.tab.active': 'Активные', 'bks.tab.held': 'Ждут оплаты', 'bks.tab.soon': 'Сгорают скоро', 'bks.tab.closed': 'Закрытые',
    'bks.search': 'Поиск: № брони, квартира, телефон, имя', 'bks.col.booking': 'Бронь', 'bks.col.apartment': 'Квартира', 'bks.col.client': 'Клиент', 'bks.col.status': 'Статус и срок',
    'bks.col.deposit': 'Депозит', 'bks.col.channel': 'Канал', 'bks.col.assignee': 'Ответственный', 'bks.until': 'до {when}', 'bks.closedAt': 'закрыта {when}',
    'bks.aptLine': '{rooms} · {floor} эт.', 'bks.card': 'Бронь №{no}', 'bks.apartment': 'Квартира', 'bks.openApt': 'Открыть на шахматке', 'bks.client': 'Клиент', 'bks.phone': 'Телефон',
    'bks.channel': 'Канал', 'bks.assignee': 'Ответственный', 'bks.heldAt': 'Начато', 'bks.bookedAt': 'Оплачено', 'bks.extendedN': 'Продлений', 'bks.consent': 'Согласие с офертой',
    'bks.term': 'Срок', 'bks.payments': 'Оплаты', 'bks.history': 'События брони', 'bks.nothing': 'Пока ничего',
    'bks.extend': 'Продлить', 'bks.cancel': 'Отменить', 'bks.copyLink': 'Скопировать личную ссылку', 'bks.linkCopied': 'Ссылка скопирована',
    'bks.extendTitle': 'Продлить бронь №{no}', 'bks.extendLead': 'Не дальше, чем на {h} ч от текущего момента.', 'bks.extendH': 'На {h} ч', 'bks.extendDate': 'До даты',
    'bks.newTerm': 'Новый срок', 'bks.reason': 'Причина', 'bks.extendDo': 'Продлить', 'bks.extended': 'Бронь продлена',
    'bks.cancelTitle': 'Отменить бронь №{no}', 'bks.cancelLead': 'Клиент: депозит остаётся у застройщика. Застройщик: по вине застройщика депозит вернётся автоматически.',
    'bks.cancelHeld': 'Оплаты ещё нет: клиент получит сообщение об отмене оформления.', 'bks.initiator': 'Кто отменяет', 'bks.byClient': 'Клиент', 'bks.byDeveloper': 'Застройщик',
    'bks.cancelDo': 'Отменить бронь', 'bks.cancelled': 'Бронь отменена', 'bks.cancelledRefund': 'Бронь отменена, возврат депозита запущен',
    'bks.stale': 'Бронь изменилась, обновили карточку', 'bks.loadFail': 'Не удалось загрузить бронь', 'bks.notFound': 'Брони с таким номером нет',
    'bks.pickDate': 'Укажите дату и время', 'bks.coPay': 'Платёж' },
  en: { 'nav.bookings': 'Bookings', 'bks.title': 'Bookings', 'bks.tab.active': 'Active', 'bks.tab.held': 'Awaiting payment', 'bks.tab.soon': 'Expiring soon', 'bks.tab.closed': 'Closed',
    'bks.search': 'Search: booking no., apartment, phone, name', 'bks.col.booking': 'Booking', 'bks.col.apartment': 'Apartment', 'bks.col.client': 'Client', 'bks.col.status': 'Status and deadline',
    'bks.col.deposit': 'Deposit', 'bks.col.channel': 'Channel', 'bks.col.assignee': 'Assigned to', 'bks.until': 'until {when}', 'bks.closedAt': 'closed {when}',
    'bks.aptLine': '{rooms} · fl. {floor}', 'bks.card': 'Booking {no}', 'bks.apartment': 'Apartment', 'bks.openApt': 'Open on the board', 'bks.client': 'Client', 'bks.phone': 'Phone',
    'bks.channel': 'Channel', 'bks.assignee': 'Assigned to', 'bks.heldAt': 'Started', 'bks.bookedAt': 'Paid', 'bks.extendedN': 'Extensions', 'bks.consent': 'Offer consent',
    'bks.term': 'Deadline', 'bks.payments': 'Payments', 'bks.history': 'Booking events', 'bks.nothing': 'Nothing yet',
    'bks.extend': 'Extend', 'bks.cancel': 'Cancel', 'bks.copyLink': 'Copy personal link', 'bks.linkCopied': 'Link copied',
    'bks.extendTitle': 'Extend booking {no}', 'bks.extendLead': 'No further than {h} h from now.', 'bks.extendH': 'By {h} h', 'bks.extendDate': 'Until a date',
    'bks.newTerm': 'New deadline', 'bks.reason': 'Reason', 'bks.extendDo': 'Extend', 'bks.extended': 'Booking extended',
    'bks.cancelTitle': 'Cancel booking {no}', 'bks.cancelLead': 'Client: the deposit stays with the developer. Developer: the deposit is returned automatically.',
    'bks.cancelHeld': 'Nothing is paid yet: the client will get a message that the booking was cancelled.', 'bks.initiator': 'Cancelled by', 'bks.byClient': 'Client', 'bks.byDeveloper': 'Developer',
    'bks.cancelDo': 'Cancel booking', 'bks.cancelled': 'Booking cancelled', 'bks.cancelledRefund': 'Booking cancelled, the deposit refund has started',
    'bks.stale': 'The booking has changed, the card is refreshed', 'bks.loadFail': 'Could not load the booking', 'bks.notFound': 'No booking with this number',
    'bks.pickDate': 'Pick a date and time', 'bks.coPay': 'Payment' },
  uz: { 'nav.bookings': 'Bronlar', 'bks.title': 'Bronlar', 'bks.tab.active': 'Faol', 'bks.tab.held': 'To‘lov kutmoqda', 'bks.tab.soon': 'Tez orada tugaydi', 'bks.tab.closed': 'Yopilgan',
    'bks.search': 'Qidiruv: bron raqami, kvartira, telefon, ism', 'bks.col.booking': 'Bron', 'bks.col.apartment': 'Kvartira', 'bks.col.client': 'Mijoz', 'bks.col.status': 'Holat va muddat',
    'bks.col.deposit': 'Depozit', 'bks.col.channel': 'Kanal', 'bks.col.assignee': 'Mas’ul', 'bks.until': '{when} gacha', 'bks.closedAt': 'yopilgan {when}',
    'bks.aptLine': '{rooms} · {floor}-qavat', 'bks.card': '{no}-bron', 'bks.apartment': 'Kvartira', 'bks.openApt': 'Shaxmatkada ochish', 'bks.client': 'Mijoz', 'bks.phone': 'Telefon',
    'bks.channel': 'Kanal', 'bks.assignee': 'Mas’ul', 'bks.heldAt': 'Boshlangan', 'bks.bookedAt': 'To‘langan', 'bks.extendedN': 'Uzaytirishlar', 'bks.consent': 'Oferta roziligi',
    'bks.term': 'Muddat', 'bks.payments': 'To‘lovlar', 'bks.history': 'Bron voqealari', 'bks.nothing': 'Hozircha hech narsa',
    'bks.extend': 'Uzaytirish', 'bks.cancel': 'Bekor qilish', 'bks.copyLink': 'Shaxsiy havolani nusxalash', 'bks.linkCopied': 'Havola nusxalandi',
    'bks.extendTitle': '{no}-bronni uzaytirish', 'bks.extendLead': 'Hozirdan boshlab {h} soatdan oshmasin.', 'bks.extendH': '{h} soatga', 'bks.extendDate': 'Sanagacha',
    'bks.newTerm': 'Yangi muddat', 'bks.reason': 'Sabab', 'bks.extendDo': 'Uzaytirish', 'bks.extended': 'Bron uzaytirildi',
    'bks.cancelTitle': '{no}-bronni bekor qilish', 'bks.cancelLead': 'Mijoz: depozit quruvchida qoladi. Quruvchi: depozit avtomatik qaytariladi.',
    'bks.cancelHeld': 'To‘lov hali yo‘q: mijozga rasmiylashtirish bekor qilingani haqida xabar boradi.', 'bks.initiator': 'Kim bekor qiladi', 'bks.byClient': 'Mijoz', 'bks.byDeveloper': 'Quruvchi',
    'bks.cancelDo': 'Bronni bekor qilish', 'bks.cancelled': 'Bron bekor qilindi', 'bks.cancelledRefund': 'Bron bekor qilindi, depozitni qaytarish boshlandi',
    'bks.stale': 'Bron o‘zgardi, karta yangilandi', 'bks.loadFail': 'Bronni yuklab bo‘lmadi', 'bks.notFound': 'Bunday raqamli bron yo‘q',
    'bks.pickDate': 'Sana va vaqtni tanlang', 'bks.coPay': 'To‘lov' }
});

const POLL_MS = 5000;
const TABS = ['active', 'held', 'soon', 'closed'];
const HOURS = ['24', '48', '72'];

export function mount(root, { staff, params }) {
  const S = { tab: 'active', q: '', items: [], next: null, counts: null, loaded: false, failed: false };
  let selected = Number(params[0]) || null, card = null, cardSig = '', cardToken = 0, listToken = 0;
  let offset = 0, timer = null, searchTimer = null, dead = false;

  const tabs = el('div', { class: 'adm2-tabs', role: 'tablist' });
  const search = el('input', { type: 'search', class: 'adm2-search', placeholder: t('bks.search'), 'aria-label': t('bks.search'), maxLength: 60,
    on: { input: e => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { S.q = e.target.value.trim(); S.items = []; S.next = null; load(); }, 300); } } });
  const info = el('p', { class: 'adm2-muted adm2-info' });
  const list = el('div', { class: 'adm2-tablewrap' });
  const more = el('div', { class: 'adm2-more' });
  const side = el('aside', { class: 'adm2-side', hidden: true });
  root.replaceChildren(el('h1', { class: 'adm2-h1' }, t('bks.title')), el('div', { class: 'adm2-filters' }, tabs, search), info,
    el('div', { class: 'adm2-split list' }, el('div', {}, list, more), side));

  const nowMs = () => Date.now() + offset;
  const termOf = b => {
    if (b.status !== 'held' && b.status !== 'booked') return t('bks.closedAt', { when: dateTime(b.closedAt ?? b.expiresAt) });
    const rest = left(new Date(b.expiresAt).getTime() - nowMs());
    return `${t('bks.until', { when: dateTime(b.expiresAt) })} · ${rest ? t('apt.leftOf', { left: rest }) : t('apt.overdue')}`;
  };
  const clientLine = c => `${c.phone || '—'}${c.telegramLinked ? ' · ✈️' : ''}`;

  function drawTabs() {
    tabs.replaceChildren(...TABS.map(id => el('button', { type: 'button', role: 'tab', 'aria-selected': String(S.tab === id), dataset: { tab: id },
      class: 'adm2-chip' + (S.tab === id ? ' on' : '') + (id === 'soon' ? ' soon' : ''),
      on: { click: () => { if (S.tab !== id) { S.tab = id; S.items = []; S.next = null; S.loaded = false; load(); drawList(); } } } },
    t('bks.tab.' + id), S.counts && id !== 'closed' && el('b', {}, String(S.counts[id])))));
  }

  function row(b) {
    return el('tr', { class: (b.soon ? 'soon ' : '') + (b.no === selected ? 'sel' : ''), tabindex: 0, dataset: { no: b.no },
      on: { click: () => pick(b.no), keydown: e => { if (e.key === 'Enter') pick(b.no); } } },
    el('td', {}, el('b', {}, `№${b.no}`)),
    el('td', {}, `№${b.apartment.no}`, el('small', {}, t('bks.aptLine', { rooms: roomsLabel(b.apartment.rooms), floor: b.apartment.floor }))),
    el('td', {}, b.client.name || '—', el('small', {}, clientLine(b.client))),
    el('td', {}, el('span', { class: `adm2-badge bk-${b.status}` }, t('bk.' + b.status)), el('small', {}, termOf(b))),
    el('td', {}, money(b.deposit), b.payment && el('small', {}, `${method(b.payment)} · ${b.payment.code}`)),
    el('td', {}, label('ch.', b.channel)),
    el('td', {}, b.assignee || '—'));
  }

  function drawList() {
    drawTabs();
    const head = ['booking', 'apartment', 'client', 'status', 'deposit', 'channel', 'assignee'].map(c => el('th', {}, t('bks.col.' + c)));
    list.replaceChildren(S.items.length
      ? el('table', { class: 'adm2-table' }, el('thead', {}, el('tr', {}, head)), el('tbody', {}, S.items.map(row)))
      : el('p', { class: 'adm2-empty' }, S.loaded ? t('list.empty') : t('app.loading')));
    more.replaceChildren(...(S.next ? [el('button', { type: 'button', class: 'btn', on: { click: () => load({ more: true }) } }, t('list.more'))] : []));
    info.textContent = S.failed ? t('app.fail') : '';
  }

  async function load({ more: append = false } = {}) {
    const mine = ++listToken;
    const qs = new URLSearchParams({ tab: S.tab });
    if (S.q) qs.set('q', S.q);
    if (append) qs.set('cursor', S.next);
    else qs.set('limit', String(Math.min(200, Math.max(50, S.items.length))));
    try {
      const r = await api(`/api/admin/bookings?${qs}`);
      if (dead || mine !== listToken) return;
      S.items = append ? S.items.concat(r.items) : r.items;
      S.next = r.next; S.counts = r.counts; S.loaded = true; S.failed = false;
      offset = new Date(r.at).getTime() - Date.now();
    } catch (ex) {
      if (dead || mine !== listToken || (ex instanceof ApiError && ex.status === 401)) return;
      if (!S.failed) toast(t('app.fail'), true);
      S.failed = true;
    }
    drawList();
  }

  // ---- the card ----
  const kv = (k, v) => el('div', { class: 'adm2-kv' }, el('span', {}, k), el('b', {}, v));
  const section = (title, items) => el('section', { class: 'adm2-sec' }, el('h3', {}, title),
    items.length ? el('ul', { class: 'adm2-list' }, items) : el('p', { class: 'adm2-muted' }, t('bks.nothing')));
  const paymentRow = p => el('li', {}, el('a', { class: 'adm2-link', href: `#/payments/${p.id}` }, p.code), ' ', payBadge(p.status),
    p.refund && [' ', refundBadge(p.refund.status)],
    el('div', { class: 'adm2-muted' }, `${money(p.amount)} · ${method(p)}${p.failureReason ? ' · ' + label('pay.fail.', p.failureReason) : ''}`));
  const eventRow = e => el('li', {}, el('span', { class: 'adm2-muted' }, dateTime(e.at)), ' ', evLabel(e.type), ' ',
    el('span', { class: 'adm2-muted' }, `(${e.actor === 'staff' && e.staff ? e.staff : label('actor.', e.actor)})`));

  function drawCard() {
    if (selected == null) { side.hidden = true; document.body.classList.remove('adm2-card-open'); return; }
    side.hidden = false;
    document.body.classList.add('adm2-card-open');
    if (!card) { side.replaceChildren(el('p', { class: 'adm2-muted' }, t('app.loading'))); return; }
    const b = card.booking, a = card.apartment;
    side.replaceChildren(
      el('div', { class: 'adm2-side-head' }, el('h2', {}, t('bks.card', { no: b.no })), el('span', { class: `adm2-badge bk-${b.status}` }, t('bk.' + b.status)),
        el('button', { type: 'button', class: 'btn ghost sm', 'aria-label': t('apt.close'), on: { click: () => pick(null) } }, '✕')),
      el('div', { class: 'adm2-facts' },
        kv(t('bks.apartment'), `№${a.no} · ${roomsLabel(a.rooms)} · ${t('apt.areaV', { n: a.area })} · ${t('units.floorN', { n: a.floor })}`),
        kv(t('bks.client'), b.client.name || '—'), kv(t('bks.phone'), b.client.phone || '—'), kv('Telegram', b.client.telegramLinked ? t('apt.tgLinked') : t('apt.noTg')),
        kv(t('apt.deposit'), money(b.deposit)), kv(t('apt.price'), money(b.price)), kv(t('bks.channel'), label('ch.', b.channel)),
        kv(t('bks.assignee'), b.assignee || '—'), kv(t('bks.heldAt'), dateTime(b.heldAt)), b.bookedAt && kv(t('bks.bookedAt'), dateTime(b.bookedAt)),
        kv(t('bks.term'), termOf(b)), kv(t('bks.extendedN'), String(b.extendedCount)), kv(t('bks.consent'), dateTime(b.consentAt)),
        b.cancelInitiator && el('p', { class: 'adm2-muted' }, `${t('apt.cancelBy.' + b.cancelInitiator)}${b.cancelReason ? ' — ' + t('apt.reason', { text: b.cancelReason }) : ''}`)),
      el('div', { class: 'adm2-actions' },
        b.canExtend && el('button', { type: 'button', class: 'btn primary sm', dataset: { act: 'extend' }, on: { click: askExtend } }, t('bks.extend')),
        b.canCancel && el('button', { type: 'button', class: 'btn danger sm', dataset: { act: 'cancel' }, on: { click: askCancel } }, t('bks.cancel')),
        el('button', { type: 'button', class: 'btn sm', dataset: { act: 'link' }, on: { click: copyLink } }, t('bks.copyLink')),
        b.bookedAt && el('a', { class: 'btn ghost sm', dataset: { act: 'pdf' }, href: `/api/admin/bookings/${b.no}/pdf`, download: '' }, 'PDF'),
        el('a', { class: 'btn ghost sm', href: `#/units/${a.no}` }, t('bks.openApt'))),
      staff.role === 'head' && shiftBlock(b, () => refreshAfter()),
      section(t('bks.payments'), card.payments.map(paymentRow)),
      section(t('bks.history'), card.history.map(eventRow)));
  }

  async function loadCard() {
    if (selected == null) return;
    const mine = ++cardToken, no = selected;
    try {
      const c = await api(`/api/admin/bookings/${no}`);
      if (dead || mine !== cardToken) return;
      const sig = JSON.stringify({ ...c, at: 0 }) + left(new Date(c.booking.expiresAt).getTime() - nowMs());
      card = c;
      if (sig !== cardSig) { cardSig = sig; drawCard(); }
    } catch (ex) {
      if (dead || mine !== cardToken || (ex instanceof ApiError && ex.status === 401)) return;
      card = null;
      side.replaceChildren(el('p', { class: 'adm2-err' }, ex instanceof ApiError && ex.status === 404 ? t('bks.notFound') : t('bks.loadFail')));
    }
  }

  function pick(no) {
    selected = selected === no ? null : no;
    card = null; cardSig = ''; cardToken++;
    history.replaceState(null, '', '#/bookings' + (selected ? '/' + selected : ''));
    drawList(); drawCard(); loadCard();
  }

  // ---- actions: one Idempotency-Key per dialog (one intention), the version the screen saw ----
  const refreshAfter = async () => { cardSig = ''; await Promise.all([load(), loadCard()]); };
  const stale = async () => { toast(t('bks.stale'), true); await refreshAfter(); return 'stale'; };

  function askExtend() {
    const b = card.booking, key = newKey();
    return askForm({
      title: t('bks.extendTitle', { no: b.no }), lead: t('bks.extendLead', { h: card.limits.extendMaxHours }), submit: t('bks.extendDo'),
      fields: [
        { name: 'choice', kind: 'radio', label: t('bks.extend'), value: HOURS[0], options: [...HOURS.map(h => ({ value: h, label: t('bks.extendH', { h }) })), { value: 'date', label: t('bks.extendDate') }] },
        { name: 'until', kind: 'datetime', label: t('bks.newTerm'), when: v => v.choice === 'date' },
        { name: 'reason', kind: 'area', label: t('bks.reason'), required: true }],
      run: async v => {
        const span = v.choice === 'date'
          ? (v.until ? { until: new Date(`${v.until}:00+05:00`).toISOString() } : (() => { throw new Error(t('bks.pickDate')); })())
          : { hours: Number(v.choice) };
        try {
          await api(`/api/admin/bookings/${b.no}/extend`, { method: 'POST', key, body: { ...span, reason: v.reason, expectedVersion: b.version } });
        } catch (ex) {
          if (isStale(ex)) return stale();
          throw ex;
        }
        toast(t('bks.extended'));
        await refreshAfter();
      }
    });
  }

  function askCancel() {
    const b = card.booking, key = newKey(), held = b.status === 'held';
    return askForm({
      title: t('bks.cancelTitle', { no: b.no }), lead: held ? t('bks.cancelHeld') : t('bks.cancelLead'), submit: t('bks.cancelDo'), danger: true,
      fields: [
        { name: 'initiator', kind: 'radio', label: t('bks.initiator'), value: held ? 'developer' : 'client',
          options: [...(held ? [] : [{ value: 'client', label: t('bks.byClient') }]), { value: 'developer', label: t('bks.byDeveloper') }] },
        { name: 'reason', kind: 'area', label: t('bks.reason'), required: true }],
      run: async v => {
        let r;
        try {
          r = await api(`/api/admin/bookings/${b.no}/cancel`, { method: 'POST', key, body: { initiator: v.initiator, reason: v.reason, expectedVersion: b.version } });
        } catch (ex) {
          if (isStale(ex)) return stale();
          throw ex;
        }
        toast(r.refund ? t('bks.cancelledRefund') : t('bks.cancelled'));
        await refreshAfter();
      }
    });
  }

  async function copyLink() {
    try {
      const { link } = await api(`/api/admin/bookings/${card.booking.no}/link`);
      const url = location.origin + link;
      try { await navigator.clipboard.writeText(url); toast(t('bks.linkCopied')); } catch { toast(url); }
    } catch (ex) {
      toast(ex instanceof ApiError ? ex.message : t('app.fail'), true);
    }
  }

  const poll = () => { if (!dead) { load(); loadCard(); } };
  const onVisible = () => { if (!document.hidden) poll(); };
  document.addEventListener('visibilitychange', onVisible);
  timer = setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);

  drawList(); drawCard();
  load(); loadCard();
  return () => { dead = true; clearInterval(timer); clearTimeout(searchTimer); document.removeEventListener('visibilitychange', onVisible); document.body.classList.remove('adm2-card-open'); };
}
