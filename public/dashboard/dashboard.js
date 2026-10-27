// The dashboard (12 §9): tiles, funnel, charts, the mini board, the AI activity and the live feed, full screen. The server cuts the answer by role (D-26);
// here a missing field just means no block. Data goes into the page as text only. The feed is polled every 3 s; a money event reloads the summary
// and the charts at once, otherwise the summary comes every 30 s. Polling stops on a hidden tab and ends with stop().
import { api } from '../admin/api.js';
import { el } from '../admin/ui.js';
import { t, addTexts, getLang, onLangChange } from '../admin/i18n.js';
import { barChart, lineChart, stackBars } from './charts.js';

export const FEED_MS = 3000, SUMMARY_MS = 30000, COUNT_MS = 600, HIGHLIGHT_MS = 2000, FEED_KEEP = 50;
export const PERIODS = ['today', '7d', '30d'];
const MONEY_EVENTS = new Set(['booking.paid', 'order.prepaid', 'refund.succeeded', 'apartment.sold']);
const ICON = { 'booking.paid': '●', 'apartment.sold': '★', 'booking.held': '○', 'viewing.created': '◆', 'refund.succeeded': '↩', 'booking.expired': '✕', 'booking.hold_expired': '✕', 'payment.failed': '!' };
const LOCALE = { ru: 'ru-RU', uz: 'uz-UZ', en: 'en-GB' };
const TZ = 'Asia/Tashkent';

addTexts({
  ru: { 'dsh.title': 'Chinor Park · Продажи', 'dsh.period.today': 'Сегодня', 'dsh.period.7d': '7 дней', 'dsh.period.30d': '30 дней', 'dsh.admin': 'Админка',
    'dsh.ai': 'ИИ', 'dsh.ai.primary': 'основная', 'dsh.ai.reserve': 'резерв', 'dsh.ai.scripts': 'сценарии',
    'dsh.sold': 'Продано', 'dsh.booked': 'В брони', 'dsh.deposits': 'Депозиты', 'dsh.free': 'Свободно', 'dsh.burning': 'Сгорает за 24 ч',
    'dsh.freeOf': '{n} из {total}', 'dsh.onPay': '+{n} на оплате', 'dsh.vsPrev': 'к прошлому периоду',
    'dsh.mln': 'млн', 'dsh.bln': 'млрд', 'dsh.funnel': 'Воронка', 'dsh.funnelNote': 'по удержаниям, начатым за период',
    'dsh.f.visitors': 'Посетители', 'dsh.f.dialogs': 'Диалоги', 'dsh.f.bookings': 'Брони', 'dsh.f.paid': 'Оплаты', 'dsh.f.sales': 'Продажи',
    'dsh.c.visitorToDialog': 'Посетитель → диалог', 'dsh.c.dialogToBooking': 'Диалог → бронь', 'dsh.c.bookingToSale': 'Бронь → продажа', 'dsh.c.expiredShare': 'Сгоревшие брони',
    'dsh.c.handoffShare': 'Передано менеджеру', 'dsh.c.median': 'Первое сообщение → бронь', 'dsh.minutes': '{n} мин',
    'dsh.ch.deposits': 'Депозиты', 'dsh.ch.bookings': 'Брони', 'dsh.ch.byType': 'По типам квартир', 'dsh.held': 'удержания', 'dsh.paid': 'оплаты',
    'dsh.sold1': 'продано', 'dsh.booked1': 'в брони', 'dsh.held1': 'на оплате', 'dsh.free1': 'свободно', 'dsh.studio': 'Студия', 'dsh.roomsN': '{n} комн.',
    'dsh.board': 'Мини-шахматка', 'dsh.floor': '{n} эт.', 'dsh.aiAct': 'Активность ИИ',
    'dsh.a.dialogs': 'Диалогов', 'dsh.a.turns': 'Ходов', 'dsh.a.tools': 'Вызовов инструментов', 'dsh.a.errors': 'Ошибок', 'dsh.a.fallbacks': 'Переходов на резерв',
    'dsh.a.cost': 'Расход, $', 'dsh.a.feedback': '👍 / 👎', 'dsh.a.unanswered': 'Вопросов без ответа', 'dsh.a.gemini': 'запросов сегодня {used} из {limit}',
    'dsh.feed': 'Живая лента', 'dsh.feedEmpty': 'Событий пока нет', 'dsh.offline': 'Нет связи, повторяем', 'dsh.theme': 'Тема', 'dsh.signin': 'Войдите в админку, чтобы открыть дашборд' },
  en: { 'dsh.title': 'Chinor Park · Sales', 'dsh.period.today': 'Today', 'dsh.period.7d': '7 days', 'dsh.period.30d': '30 days', 'dsh.admin': 'Admin',
    'dsh.ai': 'AI', 'dsh.ai.primary': 'primary', 'dsh.ai.reserve': 'reserve', 'dsh.ai.scripts': 'scripts',
    'dsh.sold': 'Sold', 'dsh.booked': 'Booked', 'dsh.deposits': 'Deposits', 'dsh.free': 'Free', 'dsh.burning': 'Expiring in 24 h',
    'dsh.freeOf': '{n} of {total}', 'dsh.onPay': '+{n} being paid', 'dsh.vsPrev': 'vs the previous period',
    'dsh.mln': 'M', 'dsh.bln': 'B', 'dsh.funnel': 'Funnel', 'dsh.funnelNote': 'by holds started in the period',
    'dsh.f.visitors': 'Visitors', 'dsh.f.dialogs': 'Dialogues', 'dsh.f.bookings': 'Holds', 'dsh.f.paid': 'Payments', 'dsh.f.sales': 'Sales',
    'dsh.c.visitorToDialog': 'Visitor → dialogue', 'dsh.c.dialogToBooking': 'Dialogue → booking', 'dsh.c.bookingToSale': 'Booking → sale', 'dsh.c.expiredShare': 'Expired bookings',
    'dsh.c.handoffShare': 'Handed to a manager', 'dsh.c.median': 'First message → booking', 'dsh.minutes': '{n} min',
    'dsh.ch.deposits': 'Deposits', 'dsh.ch.bookings': 'Bookings', 'dsh.ch.byType': 'By apartment type', 'dsh.held': 'holds', 'dsh.paid': 'payments',
    'dsh.sold1': 'sold', 'dsh.booked1': 'booked', 'dsh.held1': 'being paid', 'dsh.free1': 'free', 'dsh.studio': 'Studio', 'dsh.roomsN': '{n} rooms',
    'dsh.board': 'Mini board', 'dsh.floor': 'fl. {n}', 'dsh.aiAct': 'AI activity',
    'dsh.a.dialogs': 'Dialogues', 'dsh.a.turns': 'Turns', 'dsh.a.tools': 'Tool calls', 'dsh.a.errors': 'Errors', 'dsh.a.fallbacks': 'Switches to reserve',
    'dsh.a.cost': 'Spend, $', 'dsh.a.feedback': '👍 / 👎', 'dsh.a.unanswered': 'Unanswered questions', 'dsh.a.gemini': 'requests today {used} of {limit}',
    'dsh.feed': 'Live feed', 'dsh.feedEmpty': 'No events yet', 'dsh.offline': 'No connection, retrying', 'dsh.theme': 'Theme', 'dsh.signin': 'Sign in to the admin to open the dashboard' },
  uz: { 'dsh.title': 'Chinor Park · Sotuvlar', 'dsh.period.today': 'Bugun', 'dsh.period.7d': '7 kun', 'dsh.period.30d': '30 kun', 'dsh.admin': 'Admin',
    'dsh.ai': 'AI', 'dsh.ai.primary': 'asosiy', 'dsh.ai.reserve': 'zaxira', 'dsh.ai.scripts': 'stsenariylar',
    'dsh.sold': 'Sotilgan', 'dsh.booked': 'Bronda', 'dsh.deposits': 'Depozitlar', 'dsh.free': 'Bo‘sh', 'dsh.burning': '24 soatda tugaydi',
    'dsh.freeOf': '{total} dan {n}', 'dsh.onPay': '+{n} to‘lovda', 'dsh.vsPrev': 'oldingi davrga nisbatan',
    'dsh.mln': 'mln', 'dsh.bln': 'mlrd', 'dsh.funnel': 'Voronka', 'dsh.funnelNote': 'davrda boshlangan ushlab turishlar bo‘yicha',
    'dsh.f.visitors': 'Tashrifchilar', 'dsh.f.dialogs': 'Suhbatlar', 'dsh.f.bookings': 'Bronlar', 'dsh.f.paid': 'To‘lovlar', 'dsh.f.sales': 'Sotuvlar',
    'dsh.c.visitorToDialog': 'Tashrifchi → suhbat', 'dsh.c.dialogToBooking': 'Suhbat → bron', 'dsh.c.bookingToSale': 'Bron → sotuv', 'dsh.c.expiredShare': 'Muddati o‘tgan bronlar',
    'dsh.c.handoffShare': 'Menejerga topshirilgan', 'dsh.c.median': 'Birinchi xabar → bron', 'dsh.minutes': '{n} daq',
    'dsh.ch.deposits': 'Depozitlar', 'dsh.ch.bookings': 'Bronlar', 'dsh.ch.byType': 'Kvartira turlari bo‘yicha', 'dsh.held': 'ushlab turish', 'dsh.paid': 'to‘lovlar',
    'dsh.sold1': 'sotilgan', 'dsh.booked1': 'bronda', 'dsh.held1': 'to‘lovda', 'dsh.free1': 'bo‘sh', 'dsh.studio': 'Studiya', 'dsh.roomsN': '{n} xona',
    'dsh.board': 'Mini-shaxmatka', 'dsh.floor': '{n}-qavat', 'dsh.aiAct': 'AI faolligi',
    'dsh.a.dialogs': 'Suhbatlar', 'dsh.a.turns': 'Qadamlar', 'dsh.a.tools': 'Vositalar chaqiruvi', 'dsh.a.errors': 'Xatolar', 'dsh.a.fallbacks': 'Zaxiraga o‘tishlar',
    'dsh.a.cost': 'Xarajat, $', 'dsh.a.feedback': '👍 / 👎', 'dsh.a.unanswered': 'Javobsiz savollar', 'dsh.a.gemini': 'bugungi so‘rovlar {used} / {limit}',
    'dsh.feed': 'Jonli lenta', 'dsh.feedEmpty': 'Hozircha voqealar yo‘q', 'dsh.offline': 'Aloqa yo‘q, qayta urinamiz', 'dsh.theme': 'Mavzu', 'dsh.signin': 'Dashboardni ochish uchun adminga kiring' }
});

const num = (v, digits = 0) => new Intl.NumberFormat(LOCALE[getLang()] || 'en-GB', { maximumFractionDigits: digits }).format(v);
// 15,4 bln · 170 mln · 9 500 000 → «15,4 млрд сум», «170 млн сум»; the exact value goes to the title.
export function moneyShort(v) {
  const a = Math.abs(v);
  const body = a >= 1e9 ? `${num(v / 1e9, 1)} ${t('dsh.bln')}` : a >= 1e6 ? `${num(v / 1e6, a >= 1e8 ? 0 : 1)} ${t('dsh.mln')}` : num(v);
  return `${body} ${t('unit.sum')}`;
}
const exact = v => `${num(v)} ${t('unit.sum')}`;
const pct = v => (v == null ? '—' : `${num(v * 100, 1)}%`);
const hhmm = iso => new Intl.DateTimeFormat(LOCALE[getLang()] || 'en-GB', { hour: '2-digit', minute: '2-digit', timeZone: TZ }).format(new Date(iso));

// Counts a number up to its new value in 600 ms; no animation when the person asked for less motion or the browser has no frames to give.
function countTo(node, to, fmt) {
  const from = node._v ?? to;
  node._v = to;
  const still = from === to || typeof requestAnimationFrame !== 'function' || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  node._run = (node._run ?? 0) + 1;
  if (still) { node.textContent = fmt(to); return; }
  const run = node._run, t0 = performance.now();
  const frame = now => {
    if (node._run !== run) return;
    const k = Math.min(1, (now - t0) / COUNT_MS);
    node.textContent = fmt(from + (to - from) * (1 - (1 - k) ** 3));
    if (k < 1) requestAnimationFrame(frame); else node.textContent = fmt(to);
  };
  requestAnimationFrame(frame);
}

const THEME = 'fsp3d.theme';
function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME, next); } catch { /* storage unavailable */ }
}
const savedPeriod = () => { try { const p = localStorage.getItem('dsh.period'); return PERIODS.includes(p) ? p : 'today'; } catch { return 'today'; } };

// opts — { feedMs, summaryMs } for tests. → stop().
export function mount(root, { staff, feedMs = FEED_MS, summaryMs = SUMMARY_MS } = {}) {
  const head = staff?.role === 'head';
  const S = { period: savedPeriod(), summary: null, charts: null, units: null, feed: [], seen: new Set(), cursor: 0, first: true, offline: false };
  const flashed = new Map();
  let dead = false, busyFeed = false, summaryToken = 0, view = null;

  // ---- the page ------------------------------------------------------------------------------------------------------------------------
  function build() {
    const refs = { value: {}, sub: {}, cmp: {} };
    const tile = (id, label, href) => {
      const value = el('b', { class: 'dsh-num', dataset: { tile: id } }, '—'), sub = el('small', { class: 'dsh-sub' }), cmp = el('small', { class: 'dsh-cmp' });
      refs.value[id] = value; refs.sub[id] = sub; refs.cmp[id] = cmp;
      return el(href ? 'a' : 'div', { class: 'dsh-tile', ...(href ? { href, target: '_blank', rel: 'noopener' } : {}) }, el('span', { class: 'dsh-label' }, label), value, sub, cmp);
    };
    const periods = el('div', { class: 'dsh-periods', role: 'group' }, PERIODS.map(p =>
      el('button', { type: 'button', class: 'dsh-period' + (p === S.period ? ' on' : ''), dataset: { period: p }, on: { click: () => setPeriod(p) } }, t('dsh.period.' + p))));
    refs.ai = el(head ? 'a' : 'span', { class: 'dsh-ai', ...(head ? { href: '/admin/#/system/services', target: '_blank', rel: 'noopener' } : {}) });
    refs.offline = el('span', { class: 'dsh-offline', hidden: true, role: 'status' }, t('dsh.offline'));
    refs.tiles = el('section', { class: 'dsh-tiles' },
      head && tile('sold', t('dsh.sold')), tile('booked', t('dsh.booked')), head && tile('deposits', t('dsh.deposits')), tile('free', t('dsh.free')),
      tile('burning', t('dsh.burning'), '/admin/#/bookings'));
    refs.funnel = el('div', { class: 'dsh-funnel' });
    refs.conv = el('ul', { class: 'dsh-conv' });
    refs.chDeposits = el('div', { class: 'dsh-chartbox', dataset: { chart: 'deposits' } });
    refs.chBookings = el('div', { class: 'dsh-chartbox', dataset: { chart: 'bookings' } });
    refs.chTypes = el('div', { class: 'dsh-chartbox', dataset: { chart: 'byType' } });
    refs.board = el('div', { class: 'dsh-board' });
    refs.act = el('ul', { class: 'dsh-act' });
    refs.feed = el('ol', { class: 'dsh-feed', 'aria-live': 'polite' });
    const card = (title, ...kids) => el('section', { class: 'dsh-card' }, el('h2', {}, title), ...kids);
    refs.page = el('div', { class: 'dsh-page' },
      el('header', { class: 'dsh-top' }, el('h1', {}, t('dsh.title')), periods, refs.offline, refs.ai,
        el('a', { class: 'btn ghost sm', href: '/admin/' }, t('dsh.admin')),
        el('button', { type: 'button', class: 'btn ghost sm', title: t('dsh.theme'), on: { click: toggleTheme } }, '◐')),
      refs.tiles,
      el('div', { class: 'dsh-grid' },
        el('div', { class: 'dsh-main' },
          card(t('dsh.funnel'), refs.funnel, el('p', { class: 'dsh-note' }, t('dsh.funnelNote')), refs.conv),
          head && card(t('dsh.ch.deposits'), refs.chDeposits),
          card(t('dsh.ch.bookings'), refs.chBookings, el('p', { class: 'dsh-legend' }, el('i', { class: 'dsh-key held' }), t('dsh.held'), ' ', el('i', { class: 'dsh-key paid' }), t('dsh.paid')))),
        el('aside', { class: 'dsh-side' }, card(t('dsh.feed'), refs.feed))),
      el('div', { class: 'dsh-low' }, card(t('dsh.ch.byType'), refs.chTypes), card(t('dsh.board'), refs.board), card(t('dsh.aiAct'), refs.act)));
    return refs;
  }

  function paint() {
    view = build();
    root.replaceChildren(view.page);
    view.offline.hidden = !S.offline;
    fillSummary(false); fillCharts(); fillBoard(false); fillFeed(new Set());
  }

  // ---- blocks ------------------------------------------------------------------------------------------------------------------------
  function fillSummary(animate = true) {
    const s = S.summary;
    if (!s) return;
    const set = (id, value, fmt, sub, cmp, title) => {
      const node = view.value[id];
      if (!node) return;
      if (animate) countTo(node, value, fmt); else { node._v = value; node.textContent = fmt(value); }
      node.title = title ?? '';
      view.sub[id].textContent = sub ?? '';
      view.cmp[id].textContent = cmp ?? '';
      view.cmp[id].className = 'dsh-cmp' + (cmp ? (s.compare?.[id]?.pct >= 0 ? ' up' : ' down') : '');
    };
    const cmpOf = id => { const c = s.compare?.[id]; return c && c.pct != null ? `${c.pct >= 0 ? '▲' : '▼'} ${num(Math.abs(c.pct))}%` : ''; };
    const { tiles } = s;
    if (tiles.sold) set('sold', tiles.sold.count, v => num(Math.round(v)), moneyShort(tiles.sold.sum), cmpOf('sold'), exact(tiles.sold.sum));
    set('booked', tiles.booked.count, v => num(Math.round(v)), tiles.booked.sum != null ? moneyShort(tiles.booked.sum) : '', '', tiles.booked.sum != null ? exact(tiles.booked.sum) : '');
    if (tiles.deposits) set('deposits', tiles.deposits.sum, moneyShort, '', cmpOf('deposits'), `${exact(tiles.deposits.sum)} · ${tiles.deposits.count}`);
    set('free', tiles.free.count, v => t('dsh.freeOf', { n: num(Math.round(v)), total: tiles.free.total }), tiles.free.held ? t('dsh.onPay', { n: tiles.free.held }) : '', '');
    set('burning', tiles.burning.count, v => num(Math.round(v)), '', '');

    const f = s.funnel, steps = ['visitors', 'dialogs', 'bookings', 'paid', 'sales'], top = Math.max(1, ...steps.map(k => f[k]));
    view.funnel.replaceChildren(...steps.flatMap((k, i) => {
      const bar = el('i', { class: 'dsh-fbar' });
      bar.style.width = `${Math.max(2, (f[k] / top) * 100)}%`;
      bar.dataset.pct = String(Math.round((f[k] / top) * 100));
      const step = el('div', { class: 'dsh-step', dataset: { step: k } }, el('span', {}, t('dsh.f.' + k)), el('b', {}, num(f[k])), bar);
      return i ? [el('span', { class: 'dsh-arrow', 'aria-hidden': 'true' }, '▸'), step] : [step];
    }));
    const c = s.conversions;
    view.conv.replaceChildren(...['visitorToDialog', 'dialogToBooking', 'bookingToSale', 'expiredShare', 'handoffShare'].map(k =>
      el('li', { dataset: { conv: k } }, el('span', {}, t('dsh.c.' + k)), el('b', {}, pct(c[k])))),
    el('li', { dataset: { conv: 'median' } }, el('span', {}, t('dsh.c.median')), el('b', {}, c.medianFirstMessageToBookingMin == null ? '—' : t('dsh.minutes', { n: num(c.medianFirstMessageToBookingMin) }))));

    const banner = { primary: ['ok', 'dsh.ai.primary'], reserve: ['warn', 'dsh.ai.reserve'] }[s.ai.mode] ?? ['bad', 'dsh.ai.scripts'];
    view.ai.className = `dsh-ai ${banner[0]}`;
    view.ai.textContent = `${t('dsh.ai')}: ● ${t(banner[1])}`;
    const a = s.ai;
    const rows = [['dialogs', f.dialogs], ['turns', a.turns], ['tools', a.toolCalls], ['errors', a.errors], ['fallbacks', a.fallbacks], ['feedback', `${a.up} / ${a.down}`], ['unanswered', a.unanswered],
      ...(a.costUsd != null ? [['cost', num(a.costUsd, 2)]] : [])];
    const g = (a.gemini ?? []).filter(x => x.limit).sort((x, y) => y.used / y.limit - x.used / x.limit)[0];
    view.act.replaceChildren(...rows.map(([k, v]) => el('li', { dataset: { act: k } }, el('span', {}, t('dsh.a.' + k)), el('b', {}, typeof v === 'number' ? num(v) : v))),
      g && el('li', { class: 'dsh-quota', dataset: { act: 'gemini' } }, el('span', {}, `${g.model}: ${t('dsh.a.gemini', { used: num(g.used), limit: num(g.limit) })}`),
        (() => { const bar = el('i', { class: 'dsh-fbar' }); bar.style.width = `${Math.min(100, (g.used / g.limit) * 100)}%`; return bar; })()));
  }

  const dayLabel = d => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
  function fillCharts() {
    const c = S.charts;
    if (!c) return;
    const hourly = c.step === 'hour', every = hourly ? 3 : c.bookings.length > 14 ? 5 : 1;
    const label = p => (hourly ? String(p.hour).padStart(2, '0') : dayLabel(p.day));
    const when = p => (hourly ? `${dayLabel(p.day)} ${String(p.hour).padStart(2, '0')}:00` : dayLabel(p.day));
    if (c.deposits) {
      view.chDeposits.replaceChildren(barChart(c.deposits.map(p => ({ label: label(p), value: p.amount / 1e6, tip: `${when(p)} · ${exact(p.amount)}` })),
        { every, fmt: v => num(Math.round(v * 10) / 10), label: t('dsh.ch.deposits') }));
    }
    view.chBookings.replaceChildren(lineChart(c.bookings.map(label), [{ key: 'held', values: c.bookings.map(p => p.held) }, { key: 'paid', values: c.bookings.map(p => p.paid) }],
      { every, tips: c.bookings.map(p => `${when(p)} · ${t('dsh.held')} ${p.held} · ${t('dsh.paid')} ${p.paid}`), label: t('dsh.ch.bookings') }));
    view.chTypes.replaceChildren(stackBars(c.byType.map(r => ({ label: r.rooms === 0 ? t('dsh.studio') : t('dsh.roomsN', { n: r.rooms }), parts: [
      { key: 'sold', name: t('dsh.sold1'), value: r.sold }, { key: 'booked', name: t('dsh.booked1'), value: r.booked },
      { key: 'held', name: t('dsh.held1'), value: r.held }, { key: 'free', name: t('dsh.free1'), value: r.free }] })), { label: t('dsh.ch.byType') }));
  }

  function fillBoard(flash = true) {
    if (!S.units) return;
    const floors = new Map();
    for (const u of S.units) { if (!floors.has(u.floor)) floors.set(u.floor, []); floors.get(u.floor).push(u); }
    view.board.replaceChildren(...[...floors.keys()].sort((a, b) => b - a).map(fl => el('div', { class: 'dsh-floor' },
      el('span', {}, t('dsh.floor', { n: fl })),
      el('div', {}, floors.get(fl).sort((a, b) => a.no - b.no).map(u => {
        const changed = flash && flashed.has(u.no) && flashed.get(u.no) !== u.status;
        flashed.set(u.no, u.status);
        return el('a', { class: `dsh-cell st-${u.status}${u.soon ? ' soon' : ''}${changed ? ' flash' : ''}`, href: `/admin/#/units/${u.no}`, target: '_blank', rel: 'noopener',
          title: `№${u.no} · ${t('st.' + u.status)}`, dataset: { no: u.no, status: u.status } });
      })))));
  }

  function fillFeed(fresh) {
    if (!S.feed.length) { view.feed.replaceChildren(el('li', { class: 'dsh-empty' }, t('dsh.feedEmpty'))); return; }
    view.feed.replaceChildren(...S.feed.map(i => el('li', { class: 'dsh-row' + (fresh.has(i.id) ? ' new' : ''), dataset: { id: i.id, type: i.type } },
      el('time', {}, hhmm(i.at)), el('span', { class: 'dsh-icon', 'aria-hidden': 'true' }, ICON[i.type] ?? '·'),
      i.link ? el('a', { href: i.link, target: '_blank', rel: 'noopener' }, i.text) : el('span', {}, i.text))));
    if (fresh.size) setTimeout(() => view.feed.querySelectorAll('.new').forEach(n => n.classList.remove('new')), HIGHLIGHT_MS);
  }

  // ---- data ------------------------------------------------------------------------------------------------------------------------
  // «No connection» shows while any of the sources (summary, charts, feed) is failing.
const bad = new Set();
  const online = (ok, src) => { if (ok) bad.delete(src); else bad.add(src); S.offline = bad.size > 0; if (view) view.offline.hidden = !S.offline; };

  async function loadSummary(animate = true) {
    const token = ++summaryToken, period = S.period;
    try {
      const [summary, units] = await Promise.all([api(`/api/dashboard/summary?period=${period}`), api('/api/admin/units').catch(() => null)]);
      if (dead || token !== summaryToken) return;
      S.summary = summary;
      if (units) S.units = units.units;
      online(true, 'summary');
      fillSummary(animate); fillBoard();
    } catch { if (!dead) online(false, 'summary'); }
  }
  async function loadCharts() {
    const period = S.period;
    try {
      const charts = await api(`/api/dashboard/charts?period=${period}`);
      if (dead || period !== S.period) return;
      S.charts = charts;
      online(true, 'charts');
      fillCharts();
    } catch { if (!dead) online(false, 'charts'); }
  }
  const reloadAll = () => Promise.all([loadSummary(), loadCharts()]);

  async function pollFeed() {
    if (busyFeed || dead || document.hidden) return;
    busyFeed = true;
    try {
      const r = await api(`/api/dashboard/feed?after=${S.cursor}`);
      if (dead) return;
      online(true, 'feed');
      S.cursor = Math.max(S.cursor, r.last ?? 0);
      const fresh = r.items.filter(i => !S.seen.has(i.id));
      if (fresh.length) {
        fresh.forEach(i => S.seen.add(i.id));
        S.feed = [...fresh, ...S.feed].sort((a, b) => b.id - a.id).slice(0, FEED_KEEP);
        fillFeed(S.first ? new Set() : new Set(fresh.map(i => i.id)));
        if (!S.first && fresh.some(i => MONEY_EVENTS.has(i.type))) reloadAll();
      } else if (S.first) fillFeed(new Set());
      S.first = false;
    } catch { if (!dead) online(false, 'feed'); } finally { busyFeed = false; }
  }

  function setPeriod(p) {
    if (p === S.period) return;
    S.period = p;
    try { localStorage.setItem('dsh.period', p); } catch { /* storage unavailable */ }
    view.page.querySelectorAll('.dsh-period').forEach(b => b.classList.toggle('on', b.dataset.period === p));
    reloadAll();
  }

  // ---- go ------------------------------------------------------------------------------------------------------------------------
  paint();
  reloadAll();
  pollFeed();
  const feedTimer = setInterval(pollFeed, feedMs), summaryTimer = setInterval(() => { if (!document.hidden) loadSummary(); }, summaryMs);
  const onVisible = () => { if (!document.hidden) { pollFeed(); loadSummary(); } };
  document.addEventListener('visibilitychange', onVisible);
  onLangChange(() => { if (!dead) paint(); });
  return () => { dead = true; clearInterval(feedTimer); clearInterval(summaryTimer); document.removeEventListener('visibilitychange', onVisible); };
}
