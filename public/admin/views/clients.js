// Clients (12 §5, FR-ADM-06, FR-CRM-01…03): a list with filters (score, mine, waiting for a manager, with an active booking) and search,
// the card with contacts (a mask; «Show» asks the server for the full number and leaves a trace), the score of the lead, bookings,
// payments, viewings, orders, merges, dialogs with the feed of messages, and «take for myself». Everything from the server goes into
// the page as text. The list, the card and the open dialog are refreshed by polling every 5 s.
import { api, ApiError } from '../api.js';
import { el, toast, money, dateTime } from '../ui.js';
import { t, addTexts } from '../i18n.js';
import { label, payBadge } from './common.js';
import { roomsLabel } from './units.js';

addTexts({
  ru: { 'nav.clients': 'Клиенты', 'cls.title': 'Клиенты', 'cls.search': 'Поиск: имя, телефон, @telegram', 'cls.score': 'Оценка', 'cls.mine': 'Мои', 'cls.waiting': 'Ждут менеджера',
    'cls.active': 'С активной бронью', 'cls.reset': 'Сбросить',
    'cls.col.client': 'Клиент', 'cls.col.channels': 'Каналы', 'cls.col.lang': 'Язык', 'cls.col.score': 'Оценка', 'cls.col.activity': 'Активность', 'cls.col.assignee': 'Ответственный',
    'cls.score.hot': '🔥 Горячий', 'cls.score.warm': '🌤 Тёплый', 'cls.score.cold': '❄️ Холодный', 'cls.score.none': 'Не оценён', 'cls.waitingMark': 'ждёт менеджера',
    'cls.noName': 'Без имени', 'cls.card': 'Клиент', 'cls.phone': 'Телефон', 'cls.show': 'Показать', 'cls.noPhone': 'не оставил', 'cls.verified': 'подтверждён', 'cls.notVerified': 'не подтверждён',
    'cls.telegram': 'Telegram', 'cls.tgBlocked': 'бот заблокирован', 'cls.lang': 'Язык', 'cls.firstChannel': 'Пришёл из', 'cls.created': 'Создан', 'cls.seen': 'Был на сайте',
    'cls.duplicate': 'Возможный дубль другой карточки', 'cls.assignee': 'Ответственный', 'cls.none': 'Не назначен', 'cls.take': 'Взять себе',
    'cls.taken': 'Клиент ваш', 'cls.takenBy': 'Клиента уже взял {who}', 'cls.lead': 'Оценка и резюме', 'cls.leadNext': 'Следующий шаг', 'cls.leadAt': 'Оценено',
    'cls.bookings': 'Брони', 'cls.payments': 'Оплаты', 'cls.viewings': 'Показы', 'cls.orders': 'Заказы', 'cls.dialogs': 'Диалоги с ИИ', 'cls.merges': 'Склейки', 'cls.nothing': 'Пока ничего',
    'cls.booking': 'Бронь №{no}', 'cls.aptLine': 'кв. №{no} · {rooms} · {floor} эт.', 'cls.until': 'до {when}', 'cls.order': 'Заказ №{no}', 'cls.apt': 'кв. №{no}',
    'cls.vst.scheduled': 'запланирован', 'cls.vst.done': 'состоялся', 'cls.vst.no_show': 'не пришёл', 'cls.vst.cancelled': 'отменён',
    'cls.kind.furniture': 'мебель', 'cls.kind.apartment_request': 'заявка на квартиру',
    'cls.stage.new': 'новый', 'cls.stage.accepted': 'принят', 'cls.stage.production': 'в производстве', 'cls.stage.delivery': 'доставка', 'cls.stage.assembly': 'сборка',
    'cls.stage.done': 'готов', 'cls.stage.in_work': 'в работе', 'cls.stage.cancelled': 'отменён',
    'cls.dlg': '{channel} · {when} · сообщений: {n}', 'cls.dlgHuman': 'ждёт менеджера', 'cls.dlgClose': 'Скрыть диалог', 'cls.dlgEmpty': 'В диалоге нет сообщений', 'cls.dlgFail': 'Не удалось загрузить диалог',
    'cls.role.user': 'Клиент', 'cls.role.assistant': 'ИИ', 'cls.role.staff': 'Менеджер', 'cls.role.note': 'Заметка', 'cls.block.apartments': 'Карточки квартир: {list}', 'cls.block.other': 'Блок: {type}',
    'cls.merge': 'Карточка объединена с клиентом из {channel} {when} (правило {rule})', 'cls.openBooking': 'Открыть', 'cls.loadFail': 'Не удалось загрузить клиента', 'cls.notFound': 'Такого клиента нет' },
  en: { 'nav.clients': 'Clients', 'cls.title': 'Clients', 'cls.search': 'Search: name, phone, @telegram', 'cls.score': 'Score', 'cls.mine': 'Mine', 'cls.waiting': 'Waiting for a manager',
    'cls.active': 'With an active booking', 'cls.reset': 'Reset',
    'cls.col.client': 'Client', 'cls.col.channels': 'Channels', 'cls.col.lang': 'Language', 'cls.col.score': 'Score', 'cls.col.activity': 'Activity', 'cls.col.assignee': 'Assignee',
    'cls.score.hot': '🔥 Hot', 'cls.score.warm': '🌤 Warm', 'cls.score.cold': '❄️ Cold', 'cls.score.none': 'Not scored', 'cls.waitingMark': 'waiting for a manager',
    'cls.noName': 'No name', 'cls.card': 'Client', 'cls.phone': 'Phone', 'cls.show': 'Show', 'cls.noPhone': 'not left', 'cls.verified': 'verified', 'cls.notVerified': 'not verified',
    'cls.telegram': 'Telegram', 'cls.tgBlocked': 'bot blocked', 'cls.lang': 'Language', 'cls.firstChannel': 'Came from', 'cls.created': 'Created', 'cls.seen': 'Last seen',
    'cls.duplicate': 'May duplicate another card', 'cls.assignee': 'Assignee', 'cls.none': 'Not assigned', 'cls.take': 'Take it',
    'cls.taken': 'The client is yours', 'cls.takenBy': '{who} has already taken the client', 'cls.lead': 'Score and summary', 'cls.leadNext': 'Next step', 'cls.leadAt': 'Scored',
    'cls.bookings': 'Bookings', 'cls.payments': 'Payments', 'cls.viewings': 'Viewings', 'cls.orders': 'Orders', 'cls.dialogs': 'AI dialogs', 'cls.merges': 'Merges', 'cls.nothing': 'Nothing yet',
    'cls.booking': 'Booking {no}', 'cls.aptLine': 'apt. {no} · {rooms} · floor {floor}', 'cls.until': 'until {when}', 'cls.order': 'Order {no}', 'cls.apt': 'apt. {no}',
    'cls.vst.scheduled': 'scheduled', 'cls.vst.done': 'done', 'cls.vst.no_show': 'no show', 'cls.vst.cancelled': 'cancelled',
    'cls.kind.furniture': 'furniture', 'cls.kind.apartment_request': 'apartment request',
    'cls.stage.new': 'new', 'cls.stage.accepted': 'accepted', 'cls.stage.production': 'in production', 'cls.stage.delivery': 'delivery', 'cls.stage.assembly': 'assembly',
    'cls.stage.done': 'done', 'cls.stage.in_work': 'in work', 'cls.stage.cancelled': 'cancelled',
    'cls.dlg': '{channel} · {when} · messages: {n}', 'cls.dlgHuman': 'waiting for a manager', 'cls.dlgClose': 'Hide the dialog', 'cls.dlgEmpty': 'No messages in the dialog', 'cls.dlgFail': 'Could not load the dialog',
    'cls.role.user': 'Client', 'cls.role.assistant': 'AI', 'cls.role.staff': 'Manager', 'cls.role.note': 'Note', 'cls.block.apartments': 'Apartment cards: {list}', 'cls.block.other': 'Block: {type}',
    'cls.merge': 'Merged with the client from {channel} on {when} (rule {rule})', 'cls.openBooking': 'Open', 'cls.loadFail': 'Could not load the client', 'cls.notFound': 'No such client' },
  uz: { 'nav.clients': 'Mijozlar', 'cls.title': 'Mijozlar', 'cls.search': 'Qidiruv: ism, telefon, @telegram', 'cls.score': 'Baho', 'cls.mine': 'Meniki', 'cls.waiting': 'Menejer kutmoqda',
    'cls.active': 'Faol broni bor', 'cls.reset': 'Tozalash',
    'cls.col.client': 'Mijoz', 'cls.col.channels': 'Kanallar', 'cls.col.lang': 'Til', 'cls.col.score': 'Baho', 'cls.col.activity': 'Faollik', 'cls.col.assignee': 'Mas’ul',
    'cls.score.hot': '🔥 Qizg‘in', 'cls.score.warm': '🌤 Iliq', 'cls.score.cold': '❄️ Sovuq', 'cls.score.none': 'Baholanmagan', 'cls.waitingMark': 'menejer kutmoqda',
    'cls.noName': 'Ismsiz', 'cls.card': 'Mijoz', 'cls.phone': 'Telefon', 'cls.show': 'Ko‘rsatish', 'cls.noPhone': 'qoldirmagan', 'cls.verified': 'tasdiqlangan', 'cls.notVerified': 'tasdiqlanmagan',
    'cls.telegram': 'Telegram', 'cls.tgBlocked': 'bot bloklangan', 'cls.lang': 'Til', 'cls.firstChannel': 'Qayerdan kelgan', 'cls.created': 'Yaratilgan', 'cls.seen': 'Oxirgi tashrif',
    'cls.duplicate': 'Boshqa kartaning dubli bo‘lishi mumkin', 'cls.assignee': 'Mas’ul', 'cls.none': 'Tayinlanmagan', 'cls.take': 'O‘zimga olish',
    'cls.taken': 'Mijoz sizniki', 'cls.takenBy': 'Mijozni allaqachon {who} oldi', 'cls.lead': 'Baho va xulosa', 'cls.leadNext': 'Keyingi qadam', 'cls.leadAt': 'Baholangan',
    'cls.bookings': 'Bronlar', 'cls.payments': 'To‘lovlar', 'cls.viewings': 'Ko‘rsatuvlar', 'cls.orders': 'Buyurtmalar', 'cls.dialogs': 'AI bilan suhbatlar', 'cls.merges': 'Birlashtirishlar', 'cls.nothing': 'Hozircha hech narsa',
    'cls.booking': '{no}-bron', 'cls.aptLine': '{no}-kv. · {rooms} · {floor}-qavat', 'cls.until': '{when} gacha', 'cls.order': '{no}-buyurtma', 'cls.apt': '{no}-kv.',
    'cls.vst.scheduled': 'rejalashtirilgan', 'cls.vst.done': 'bo‘lib o‘tdi', 'cls.vst.no_show': 'kelmadi', 'cls.vst.cancelled': 'bekor qilingan',
    'cls.kind.furniture': 'mebel', 'cls.kind.apartment_request': 'kvartira so‘rovi',
    'cls.stage.new': 'yangi', 'cls.stage.accepted': 'qabul qilingan', 'cls.stage.production': 'ishlab chiqarishda', 'cls.stage.delivery': 'yetkazish', 'cls.stage.assembly': 'yig‘ish',
    'cls.stage.done': 'tayyor', 'cls.stage.in_work': 'ishda', 'cls.stage.cancelled': 'bekor qilingan',
    'cls.dlg': '{channel} · {when} · xabarlar: {n}', 'cls.dlgHuman': 'menejer kutmoqda', 'cls.dlgClose': 'Suhbatni yashirish', 'cls.dlgEmpty': 'Suhbatda xabar yo‘q', 'cls.dlgFail': 'Suhbatni yuklab bo‘lmadi',
    'cls.role.user': 'Mijoz', 'cls.role.assistant': 'AI', 'cls.role.staff': 'Menejer', 'cls.role.note': 'Qayd', 'cls.block.apartments': 'Kvartira kartalari: {list}', 'cls.block.other': 'Blok: {type}',
    'cls.merge': 'Karta {channel}dagi mijoz bilan {when} birlashtirildi (qoida {rule})', 'cls.openBooking': 'Ochish', 'cls.loadFail': 'Mijozni yuklab bo‘lmadi', 'cls.notFound': 'Bunday mijoz yo‘q' }
});

const POLL_MS = 5000;
const SCORES = ['hot', 'warm', 'cold'];
const FLAGS = ['mine', 'waiting', 'active'];
const SEARCH_MS = 300;

export function mount(root, { params }) {
  const F = { score: '', mine: false, waiting: false, active: false, q: '' };
  const S = { items: [], next: null, loaded: false, failed: false };
  let selected = params[0] || null, card = null, cardSig = '', cardToken = 0, listToken = 0, timer = null, searchTimer = null, dead = false;
  let phone = null;                                                        // the full number of the open card, after «Show»
  let openDialog = null, feed = null, feedSig = '', feedToken = 0;

  const filters = el('div', { class: 'adm2-filters' });
  const info = el('p', { class: 'adm2-muted adm2-info' });
  const list = el('div', { class: 'adm2-tablewrap' });
  const more = el('div', { class: 'adm2-more' });
  const side = el('aside', { class: 'adm2-side', hidden: true });
  root.replaceChildren(el('h1', { class: 'adm2-h1' }, t('cls.title')), filters, info, el('div', { class: 'adm2-split list' }, el('div', {}, list, more), side));

  const reload = () => { S.items = []; S.next = null; S.loaded = false; load(); drawList(); };
  const scoreBadge = s => el('span', { class: `adm2-badge sc-${s || 'none'}` }, t('cls.score.' + (s || 'none')));

  function drawFilters() {
    const search = el('input', { type: 'search', name: 'q', class: 'adm2-search', placeholder: t('cls.search'), maxLength: 60, value: F.q, 'aria-label': t('cls.search'),
      on: { input: e => { F.q = e.target.value.trim(); clearTimeout(searchTimer); searchTimer = setTimeout(reload, SEARCH_MS); } } });
    const score = el('label', { class: 'adm2-sel' }, el('span', {}, t('cls.score')),
      el('select', { name: 'score', on: { change: e => { F.score = e.target.value; reload(); } } },
        el('option', { value: '' }, t('units.all')), SCORES.map(s => el('option', { value: s, selected: s === F.score }, t('cls.score.' + s)))));
    const flags = el('div', { class: 'adm2-chips' }, FLAGS.map(k => el('button', { type: 'button', class: 'adm2-chip' + (F[k] ? ' on' : ''), dataset: { flag: k },
      'aria-pressed': String(F[k]), on: { click: () => { F[k] = !F[k]; drawFilters(); reload(); } } }, t('cls.' + k))));
    filters.replaceChildren(search, score, flags,
      el('button', { type: 'button', class: 'btn ghost sm', on: { click: () => { Object.assign(F, { score: '', mine: false, waiting: false, active: false, q: '' }); drawFilters(); reload(); } } }, t('cls.reset')));
  }

  const channelsOf = c => c.channels.map(ch => label('ch.', ch)).join(', ');
  function row(c) {
    return el('tr', { class: c.id === selected ? 'sel' : '', tabindex: 0, dataset: { id: c.id },
      on: { click: () => pick(c.id), keydown: e => { if (e.key === 'Enter') pick(c.id); } } },
    el('td', {}, el('b', {}, c.name || t('cls.noName')), el('small', {}, `${c.phone || '—'}${c.telegramUsername ? ' · @' + c.telegramUsername : ''}`),
      c.waiting && el('small', { class: 'adm2-waiting' }, '● ' + t('cls.waitingMark'))),
    el('td', {}, channelsOf(c)),
    el('td', {}, c.lang.toUpperCase()),
    el('td', {}, scoreBadge(c.leadScore)),
    el('td', {}, dateTime(c.lastActiveAt)),
    el('td', {}, c.assignee?.name || '—'));
  }

  function drawList() {
    const head = ['client', 'channels', 'lang', 'score', 'activity', 'assignee'].map(c => el('th', {}, t('cls.col.' + c)));
    list.replaceChildren(S.items.length
      ? el('table', { class: 'adm2-table' }, el('thead', {}, el('tr', {}, head)), el('tbody', {}, S.items.map(row)))
      : el('p', { class: 'adm2-empty' }, S.loaded ? t('list.empty') : t('app.loading')));
    more.replaceChildren(...(S.next ? [el('button', { type: 'button', class: 'btn', on: { click: () => load({ more: true }) } }, t('list.more'))] : []));
    info.textContent = S.failed ? t('app.fail') : '';
  }

  async function load({ more: append = false } = {}) {
    const mine = ++listToken;
    const qs = new URLSearchParams();
    if (F.score) qs.set('score', F.score);
    for (const k of FLAGS) if (F[k]) qs.set(k, '1');
    if (F.q) qs.set('q', F.q);
    if (append) qs.set('cursor', S.next);
    else qs.set('limit', String(Math.min(200, Math.max(50, S.items.length))));
    try {
      const r = await api(`/api/admin/clients?${qs}`);
      if (dead || mine !== listToken) return;
      S.items = append ? S.items.concat(r.items) : r.items;
      S.next = r.next; S.loaded = true; S.failed = false;
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
    items.length ? el('ul', { class: 'adm2-list' }, items) : el('p', { class: 'adm2-muted' }, t('cls.nothing')));

  const bookingRow = b => el('li', {}, el('a', { href: `#/bookings/${b.no}` }, t('cls.booking', { no: b.no })), ' ',
    el('span', { class: `adm2-badge bk-${b.status}` }, label('bk.', b.status)),
    el('div', { class: 'adm2-muted' }, `${t('cls.aptLine', { no: b.apartment.no, rooms: roomsLabel(b.apartment.rooms), floor: b.apartment.floor })} · ${money(b.deposit)} · ${t('cls.until', { when: dateTime(b.expiresAt) })}`));
  const paymentRow = p => el('li', {}, el('a', { href: `#/payments/${p.id}` }, p.code), ' ', payBadge(p.status),
    el('div', { class: 'adm2-muted' }, `${money(p.amount)} · ${p.cardBrand ? p.cardBrand + ' ' + (p.cardMask || '') : label('pay.prov.', p.provider)} · ${dateTime(p.createdAt)}`));
  const viewingRow = v => el('li', {}, dateTime(v.at), ' ', el('span', { class: 'adm2-muted' }, `${t('cls.apt', { no: v.apartmentNo })} · ${label('cls.vst.', v.status)} · ${label('ch.', v.channel)}`));
  const orderRow = o => el('li', {}, el('b', {}, t('cls.order', { no: o.no })), ' ', el('span', { class: 'adm2-muted' },
    `${label('cls.kind.', o.kind)} · ${label('cls.stage.', o.stage)}${o.estimate != null ? ' · ' + money(o.estimate) : ''}${o.apartmentNo ? ' · ' + t('cls.apt', { no: o.apartmentNo }) : ''}`));
  const mergeRow = m => el('li', {}, t('cls.merge', { channel: m.fromChannel ? label('ch.', m.fromChannel) : '—', when: dateTime(m.at), rule: m.rule || '—' }));

  function dialogRow(d) {
    const on = d.id === openDialog;
    return el('li', {}, el('button', { type: 'button', class: 'adm2-link', dataset: { dialog: d.id }, 'aria-expanded': String(on), on: { click: () => toggleDialog(d.id) } },
      t('cls.dlg', { channel: label('ch.', d.channel), when: dateTime(d.lastMessageAt || d.createdAt), n: d.messageCount })),
    d.mode === 'human' && [' ', el('span', { class: 'adm2-badge bk-held' }, t('cls.dlgHuman'))],
    on && drawFeed());
  }

  const blockLine = b => {
    if (b?.type === 'apartments') {
      const nos = (b.data?.items ?? []).map(i => `№${i.no ?? i.apartmentNo ?? '?'}`).join(', ');
      return t('cls.block.apartments', { list: nos || '—' });
    }
    return t('cls.block.other', { type: String(b?.type ?? '?') });
  };
  function drawFeed() {
    if (!feed) return el('p', { class: 'adm2-muted' }, t('app.loading'));
    if (feed === 'fail') return el('p', { class: 'adm2-err' }, t('cls.dlgFail'));
    if (!feed.messages.length) return el('p', { class: 'adm2-muted' }, t('cls.dlgEmpty'));
    return el('div', {}, el('ol', { class: 'adm2-feed' }, feed.messages.map(m => el('li', { class: `msg-${m.role}`, dataset: { role: m.role } },
      el('span', { class: 'adm2-muted' }, `${label('cls.role.', m.role)} · ${dateTime(m.createdAt)}`), el('div', { class: 'adm2-msg' }, m.text),
      (m.blocks ?? []).map(b => el('div', { class: 'adm2-muted' }, blockLine(b)))))),
    el('button', { type: 'button', class: 'btn ghost sm', on: { click: () => toggleDialog(openDialog) } }, t('cls.dlgClose')));
  }

  function drawCard() {
    if (selected == null) { side.hidden = true; document.body.classList.remove('adm2-card-open'); return; }
    side.hidden = false;
    document.body.classList.add('adm2-card-open');
    if (!card) { side.replaceChildren(el('p', { class: 'adm2-muted' }, t('app.loading'))); return; }
    const c = card.client;
    const phoneRow = el('div', { class: 'adm2-kv' }, el('span', {}, t('cls.phone')),
      el('b', { dataset: { phone: '' } }, phone ?? c.phone ?? '—', ' ',
        c.hasPhone && phone == null && el('button', { type: 'button', class: 'btn ghost sm', dataset: { act: 'reveal' }, on: { click: reveal } }, t('cls.show')),
        !c.hasPhone && el('small', { class: 'adm2-muted' }, t('cls.noPhone'))));
    side.replaceChildren(
      el('div', { class: 'adm2-side-head' }, el('h2', {}, c.name || t('cls.noName')), scoreBadge(c.lead?.score),
        el('button', { type: 'button', class: 'btn ghost sm', 'aria-label': t('apt.close'), on: { click: () => pick(null) } }, '✕')),
      el('div', { class: 'adm2-facts' }, phoneRow,
        c.hasPhone && kv('', c.phoneVerified ? t('cls.verified') : t('cls.notVerified')),
        kv(t('cls.telegram'), c.telegramUsername ? `@${c.telegramUsername}${c.telegramBlocked ? ' · ' + t('cls.tgBlocked') : ''}` : c.telegramLinked ? '✈️' : '—'),
        kv(t('cls.lang'), c.lang.toUpperCase()), kv(t('cls.firstChannel'), label('ch.', c.firstChannel)),
        kv(t('cls.created'), dateTime(c.createdAt)), c.lastSeenAt && kv(t('cls.seen'), dateTime(c.lastSeenAt)),
        c.possibleDuplicate && el('p', { class: 'adm2-muted' }, t('cls.duplicate'))),
      el('div', { class: 'adm2-actions' }, kv(t('cls.assignee'), c.assignee?.name || t('cls.none')),
        !c.assignee && el('button', { type: 'button', class: 'btn primary sm', dataset: { act: 'take' }, on: { click: take } }, t('cls.take'))),
      c.lead && el('section', { class: 'adm2-sec' }, el('h3', {}, t('cls.lead')), c.lead.summary && el('p', {}, c.lead.summary),
        c.lead.nextStep && el('p', {}, el('b', {}, t('cls.leadNext') + ': '), c.lead.nextStep),
        c.lead.scoredAt && el('p', { class: 'adm2-muted' }, `${t('cls.leadAt')}: ${dateTime(c.lead.scoredAt)}`)),
      section(t('cls.bookings'), card.bookings.map(bookingRow)),
      section(t('cls.payments'), card.payments.map(paymentRow)),
      section(t('cls.viewings'), card.viewings.map(viewingRow)),
      section(t('cls.orders'), card.orders.map(orderRow)),
      section(t('cls.dialogs'), card.dialogs.map(dialogRow)),
      card.merges.length > 0 && section(t('cls.merges'), card.merges.map(mergeRow)));
  }

  async function loadCard() {
    if (selected == null) return;
    const mine = ++cardToken, id = selected;
    try {
      const c = await api(`/api/admin/clients/${encodeURIComponent(id)}`);
      if (dead || mine !== cardToken) return;
      const sig = JSON.stringify({ ...c, at: 0 });
      card = c;
      if (sig !== cardSig) { cardSig = sig; drawCard(); }
    } catch (ex) {
      if (dead || mine !== cardToken || (ex instanceof ApiError && ex.status === 401)) return;
      card = null;
      side.replaceChildren(el('p', { class: 'adm2-err' }, ex instanceof ApiError && ex.status === 404 ? t('cls.notFound') : t('cls.loadFail')));
    }
  }

  function pick(id) {
    selected = selected === id ? null : id;
    card = null; cardSig = ''; cardToken++; phone = null; openDialog = null; feed = null; feedSig = ''; feedToken++;
    history.replaceState(null, '', '#/clients' + (selected ? '/' + selected : ''));
    drawList(); drawCard(); loadCard();
  }

  // ---- actions ----
  async function reveal() {
    const id = selected;
    try {
      const r = await api(`/api/admin/clients/${encodeURIComponent(id)}/reveal-phone`, { method: 'POST', body: {} });
      if (dead || id !== selected) return;
      phone = r.phone;
      drawCard();
    } catch (ex) {
      toast(ex.message || t('app.fail'), true);
    }
  }

  async function take() {
    const id = selected;
    try {
      const r = await api(`/api/admin/clients/${encodeURIComponent(id)}/assign`, { method: 'POST', body: { staffId: 'me' } });
      if (dead || id !== selected) return;
      toast(r.taken ? t('cls.taken') : t('cls.takenBy', { who: r.client.assignee?.name ?? '—' }), !r.taken);
      cardSig = '';
      await Promise.all([loadCard(), load()]);
    } catch (ex) {
      toast(ex.message || t('app.fail'), true);
    }
  }

  async function loadFeed() {
    if (!openDialog) return;
    const mine = ++feedToken, id = openDialog;
    try {
      const f = await api(`/api/admin/conversations/${encodeURIComponent(id)}`);
      if (dead || mine !== feedToken) return;
      const sig = JSON.stringify(f.messages.map(m => m.id));
      feed = f;
      if (sig !== feedSig) { feedSig = sig; drawCard(); }
    } catch (ex) {
      if (dead || mine !== feedToken || (ex instanceof ApiError && ex.status === 401)) return;
      feed = 'fail'; feedSig = ''; drawCard();
    }
  }

  function toggleDialog(id) {
    openDialog = openDialog === id ? null : id;
    feed = null; feedSig = ''; feedToken++;
    drawCard();
    loadFeed();
  }

  const poll = () => { if (!dead) { load(); loadCard(); loadFeed(); } };
  const onVisible = () => { if (!document.hidden) poll(); };
  document.addEventListener('visibilitychange', onVisible);
  timer = setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);

  drawFilters(); drawList(); drawCard();
  load(); loadCard();
  return () => {
    dead = true; clearInterval(timer); clearTimeout(searchTimer);
    document.removeEventListener('visibilitychange', onVisible); document.body.classList.remove('adm2-card-open');
  };
}
