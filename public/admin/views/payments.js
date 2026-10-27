// Payments (12 §4.2, FR-ADM-05, FR-PAY-08): a list with filters and the total over the filter, the card of a payment (attempts, provider
// notifications, refunds) and, for the head only, «return the deposit» and «repeat the refund». Card numbers are not shown anywhere,
// only the brand and the mask. The state of a refund is refreshed by polling every 5 s.
import { api, ApiError, newKey } from '../api.js';
import { el, toast, money, dateTime, askForm } from '../ui.js';
import { t, addTexts } from '../i18n.js';
import { label, payBadge, refundBadge, method } from './common.js';

addTexts({
  ru: { 'nav.payments': 'Оплаты', 'pys.title': 'Оплаты', 'pys.provider': 'Способ', 'pys.status': 'Статус', 'pys.from': 'С', 'pys.to': 'По', 'pys.reset': 'Сбросить',
    'pys.col.code': 'Код', 'pys.col.target': 'Бронь / заказ', 'pys.col.client': 'Клиент', 'pys.col.amount': 'Сумма', 'pys.col.method': 'Способ', 'pys.col.status': 'Статус', 'pys.col.time': 'Время',
    'pys.booking': 'Бронь №{no}', 'pys.order': 'Заказ №{no}', 'pys.total': 'Успешно: {n} · {sum}', 'pys.found': 'Всего по фильтру: {n}',
    'pys.card': 'Платёж {code}', 'pys.kind': 'Назначение', 'pys.kind.deposit': 'Депозит', 'pys.kind.furniture_prepay': 'Предоплата мебели', 'pys.kind.custom': 'Прочее',
    'pys.createdAt': 'Создан', 'pys.succeededAt': 'Оплачен', 'pys.expiresAt': 'Оплатить до', 'pys.failure': 'Причина отказа', 'pys.client': 'Клиент',
    'pys.attempts': 'Другие попытки', 'pys.events': 'Уведомления платёжной системы', 'pys.refunds': 'Возвраты', 'pys.nothing': 'Пока ничего', 'pys.by': 'запросил: {who}',
    'pys.refund': 'Вернуть депозит', 'pys.retry': 'Повторить возврат', 'pys.loadFail': 'Не удалось загрузить платёж', 'pys.notFound': 'Платежа с таким номером нет',
    'pys.refundTitle': 'Вернуть депозит', 'pys.refundLead': 'Вернуть {sum} клиенту {name}? Возврат полный, частичных нет.', 'pys.refundDo': 'Вернуть', 'pys.reason': 'Причина',
    'pys.refundStarted': 'Возврат запущен', 'pys.retryTitle': 'Повторить возврат', 'pys.retryLead': 'Прошлый возврат не удался. Создать новый на {sum}?', 'pys.retryDo': 'Повторить',
    'pys.retryStarted': 'Новый возврат запущен', 'pys.stale': 'Статус платежа изменился, обновили карточку', 'pys.headOnly': 'Возвраты делает только руководитель' },
  en: { 'nav.payments': 'Payments', 'pys.title': 'Payments', 'pys.provider': 'Method', 'pys.status': 'Status', 'pys.from': 'From', 'pys.to': 'To', 'pys.reset': 'Reset',
    'pys.col.code': 'Code', 'pys.col.target': 'Booking / order', 'pys.col.client': 'Client', 'pys.col.amount': 'Amount', 'pys.col.method': 'Method', 'pys.col.status': 'Status', 'pys.col.time': 'Time',
    'pys.booking': 'Booking {no}', 'pys.order': 'Order {no}', 'pys.total': 'Succeeded: {n} · {sum}', 'pys.found': 'In this filter: {n}',
    'pys.card': 'Payment {code}', 'pys.kind': 'Purpose', 'pys.kind.deposit': 'Deposit', 'pys.kind.furniture_prepay': 'Furniture prepayment', 'pys.kind.custom': 'Other',
    'pys.createdAt': 'Created', 'pys.succeededAt': 'Paid', 'pys.expiresAt': 'Pay before', 'pys.failure': 'Failure reason', 'pys.client': 'Client',
    'pys.attempts': 'Other attempts', 'pys.events': 'Payment system notifications', 'pys.refunds': 'Refunds', 'pys.nothing': 'Nothing yet', 'pys.by': 'requested by: {who}',
    'pys.refund': 'Refund the deposit', 'pys.retry': 'Repeat the refund', 'pys.loadFail': 'Could not load the payment', 'pys.notFound': 'No payment with this id',
    'pys.refundTitle': 'Refund the deposit', 'pys.refundLead': 'Refund {sum} to {name}? The refund is full, there are no partial ones.', 'pys.refundDo': 'Refund', 'pys.reason': 'Reason',
    'pys.refundStarted': 'Refund started', 'pys.retryTitle': 'Repeat the refund', 'pys.retryLead': 'The last refund failed. Create a new one for {sum}?', 'pys.retryDo': 'Repeat',
    'pys.retryStarted': 'A new refund started', 'pys.stale': 'The payment changed, the card is refreshed', 'pys.headOnly': 'Only the head makes refunds' },
  uz: { 'nav.payments': 'To‘lovlar', 'pys.title': 'To‘lovlar', 'pys.provider': 'Usul', 'pys.status': 'Holat', 'pys.from': 'Dan', 'pys.to': 'Gacha', 'pys.reset': 'Tozalash',
    'pys.col.code': 'Kod', 'pys.col.target': 'Bron / buyurtma', 'pys.col.client': 'Mijoz', 'pys.col.amount': 'Summa', 'pys.col.method': 'Usul', 'pys.col.status': 'Holat', 'pys.col.time': 'Vaqt',
    'pys.booking': '{no}-bron', 'pys.order': '{no}-buyurtma', 'pys.total': 'Muvaffaqiyatli: {n} · {sum}', 'pys.found': 'Filtr bo‘yicha jami: {n}',
    'pys.card': '{code} to‘lovi', 'pys.kind': 'Maqsad', 'pys.kind.deposit': 'Depozit', 'pys.kind.furniture_prepay': 'Mebel oldindan to‘lovi', 'pys.kind.custom': 'Boshqa',
    'pys.createdAt': 'Yaratilgan', 'pys.succeededAt': 'To‘langan', 'pys.expiresAt': 'Gacha to‘lash', 'pys.failure': 'Rad etish sababi', 'pys.client': 'Mijoz',
    'pys.attempts': 'Boshqa urinishlar', 'pys.events': 'To‘lov tizimi xabarlari', 'pys.refunds': 'Qaytarishlar', 'pys.nothing': 'Hozircha hech narsa', 'pys.by': 'so‘ragan: {who}',
    'pys.refund': 'Depozitni qaytarish', 'pys.retry': 'Qaytarishni takrorlash', 'pys.loadFail': 'To‘lovni yuklab bo‘lmadi', 'pys.notFound': 'Bunday to‘lov yo‘q',
    'pys.refundTitle': 'Depozitni qaytarish', 'pys.refundLead': '{sum} {name}ga qaytarilsinmi? Qaytarish to‘liq, qisman qaytarish yo‘q.', 'pys.refundDo': 'Qaytarish', 'pys.reason': 'Sabab',
    'pys.refundStarted': 'Qaytarish boshlandi', 'pys.retryTitle': 'Qaytarishni takrorlash', 'pys.retryLead': 'Oldingi qaytarish bajarilmadi. {sum}ga yangisi yaratilsinmi?', 'pys.retryDo': 'Takrorlash',
    'pys.retryStarted': 'Yangi qaytarish boshlandi', 'pys.stale': 'To‘lov o‘zgardi, karta yangilandi', 'pys.headOnly': 'Qaytarishni faqat rahbar bajaradi' }
});

const POLL_MS = 5000;
const STATUSES = ['pending', 'processing', 'succeeded', 'failed', 'cancelled', 'refund_due', 'refunded'];
const PROVIDERS = ['card', 'click', 'stripe'];

export function mount(root, { staff, params }) {
  const F = { provider: '', status: '', from: '', to: '' };
  const S = { items: [], next: null, totals: null, loaded: false, failed: false };
  let selected = params[0] || null, card = null, cardSig = '', cardToken = 0, listToken = 0, timer = null, dead = false;

  const filters = el('div', { class: 'adm2-filters' });
  const info = el('p', { class: 'adm2-muted adm2-info' });
  const list = el('div', { class: 'adm2-tablewrap' });
  const total = el('p', { class: 'adm2-total' });
  const more = el('div', { class: 'adm2-more' });
  const side = el('aside', { class: 'adm2-side', hidden: true });
  root.replaceChildren(el('h1', { class: 'adm2-h1' }, t('pys.title')), filters, info,
    el('div', { class: 'adm2-split list' }, el('div', {}, list, total, more), side));

  const reload = () => { S.items = []; S.next = null; S.loaded = false; load(); drawList(); };
  function drawFilters() {
    const select = (key, caption, values, text) => el('label', { class: 'adm2-sel' }, el('span', {}, caption),
      el('select', { name: key, on: { change: e => { F[key] = e.target.value; reload(); } } },
        el('option', { value: '' }, t('units.all')), values.map(v => el('option', { value: v, selected: v === F[key] }, text(v)))));
    const date = (key, caption) => el('label', { class: 'adm2-sel' }, el('span', {}, caption),
      el('input', { type: 'date', name: key, value: F[key], on: { change: e => { F[key] = e.target.value; reload(); } } }));
    filters.replaceChildren(select('provider', t('pys.provider'), PROVIDERS, v => label('pay.prov.', v)),
      select('status', t('pys.status'), STATUSES, v => label('pay.st.', v)), date('from', t('pys.from')), date('to', t('pys.to')),
      el('button', { type: 'button', class: 'btn ghost sm', on: { click: () => { Object.keys(F).forEach(k => { F[k] = ''; }); drawFilters(); reload(); } } }, t('pys.reset')));
  }

  const targetOf = p => (p.bookingNo ? t('pys.booking', { no: p.bookingNo }) : p.orderNo ? t('pys.order', { no: p.orderNo }) : '—');
  function row(p) {
    return el('tr', { class: p.id === selected ? 'sel' : '', tabindex: 0, dataset: { id: p.id },
      on: { click: () => pick(p.id), keydown: e => { if (e.key === 'Enter') pick(p.id); } } },
    el('td', {}, el('b', {}, p.code)),
    el('td', {}, targetOf(p)),
    el('td', {}, p.client.name || '—', el('small', {}, p.client.phone || '—')),
    el('td', {}, money(p.amount)),
    el('td', {}, method(p)),
    el('td', {}, payBadge(p.status), p.refund && [' ', refundBadge(p.refund.status)], p.failureReason && el('small', {}, label('pay.fail.', p.failureReason))),
    el('td', {}, dateTime(p.createdAt)));
  }

  function drawList() {
    const head = ['code', 'target', 'client', 'amount', 'method', 'status', 'time'].map(c => el('th', {}, t('pys.col.' + c)));
    list.replaceChildren(S.items.length
      ? el('table', { class: 'adm2-table' }, el('thead', {}, el('tr', {}, head)), el('tbody', {}, S.items.map(row)))
      : el('p', { class: 'adm2-empty' }, S.loaded ? t('list.empty') : t('app.loading')));
    total.textContent = S.totals ? `${t('pys.total', { n: S.totals.succeededCount, sum: money(S.totals.succeededAmount) })} · ${t('pys.found', { n: S.totals.count })}` : '';
    more.replaceChildren(...(S.next ? [el('button', { type: 'button', class: 'btn', on: { click: () => load({ more: true }) } }, t('list.more'))] : []));
    info.textContent = S.failed ? t('app.fail') : '';
  }

  async function load({ more: append = false } = {}) {
    const mine = ++listToken;
    const qs = new URLSearchParams(Object.entries(F).filter(([, v]) => v));
    if (append) qs.set('cursor', S.next);
    else qs.set('limit', String(Math.min(200, Math.max(50, S.items.length))));
    try {
      const r = await api(`/api/admin/payments?${qs}`);
      if (dead || mine !== listToken) return;
      S.items = append ? S.items.concat(r.items) : r.items;
      S.next = r.next; S.totals = r.totals; S.loaded = true; S.failed = false;
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
    items.length ? el('ul', { class: 'adm2-list' }, items) : el('p', { class: 'adm2-muted' }, t('pys.nothing')));
  const refundRow = r => el('li', {}, refundBadge(r.status), ' ', el('span', { class: 'adm2-muted' }, `${label('rf.reason.', r.reason)} · ${money(r.amount)} · ${dateTime(r.createdAt)}`),
    r.note && el('div', {}, r.note),
    r.failure && el('div', { class: 'adm2-err' }, label('pay.fail.', r.failure)),
    el('div', { class: 'adm2-muted' }, t('pys.by', { who: r.by === 'system' ? label('actor.', 'system') : r.by })));
  const attemptRow = a => el('li', {}, el('b', {}, a.code), ' ', payBadge(a.status), ' ', el('span', { class: 'adm2-muted' }, `${label('pay.prov.', a.provider)} · ${dateTime(a.createdAt)}`),
    a.failureReason && el('div', { class: 'adm2-muted' }, label('pay.fail.', a.failureReason)));
  const eventRow = e => el('li', {}, el('span', { class: 'adm2-muted' }, dateTime(e.at)), ' ', e.type, e.result && el('span', { class: 'adm2-muted' }, ` · ${e.result}`));

  function drawCard() {
    if (selected == null) { side.hidden = true; document.body.classList.remove('adm2-card-open'); return; }
    side.hidden = false;
    document.body.classList.add('adm2-card-open');
    if (!card) { side.replaceChildren(el('p', { class: 'adm2-muted' }, t('app.loading'))); return; }
    const p = card.payment, head = staff.role === 'head';
    side.replaceChildren(
      el('div', { class: 'adm2-side-head' }, el('h2', {}, t('pys.card', { code: p.code })), payBadge(p.status),
        el('button', { type: 'button', class: 'btn ghost sm', 'aria-label': t('apt.close'), on: { click: () => pick(null) } }, '✕')),
      el('div', { class: 'adm2-facts' },
        kv(t('pys.kind'), label('pys.kind.', p.kind)), kv(t('pys.col.amount'), money(p.amount)), kv(t('pys.col.method'), method(p)),
        kv(t('pys.client'), `${p.client.name || '—'} · ${p.client.phone || '—'}`),
        kv(t('pys.col.target'), targetOf(p)),
        kv(t('pys.createdAt'), dateTime(p.createdAt)), p.succeededAt && kv(t('pys.succeededAt'), dateTime(p.succeededAt)),
        p.status === 'pending' && p.expiresAt && kv(t('pys.expiresAt'), dateTime(p.expiresAt)),
        p.failureReason && kv(t('pys.failure'), label('pay.fail.', p.failureReason))),
      el('div', { class: 'adm2-actions' },
        p.bookingNo && el('a', { class: 'btn ghost sm', href: `#/bookings/${p.bookingNo}` }, t('pys.booking', { no: p.bookingNo })),
        head && card.canRefund && el('button', { type: 'button', class: 'btn danger sm', dataset: { act: 'refund' }, on: { click: askRefund } }, t('pys.refund')),
        head && card.retryRefundId && el('button', { type: 'button', class: 'btn danger sm', dataset: { act: 'retry' }, on: { click: askRetry } }, t('pys.retry'))),
      !head && (card.canRefund || card.retryRefundId) && el('p', { class: 'adm2-muted' }, t('pys.headOnly')),
      section(t('pys.refunds'), card.refunds.map(refundRow)),
      section(t('pys.attempts'), card.attempts.map(attemptRow)),
      section(t('pys.events'), card.providerEvents.map(eventRow)));
  }

  async function loadCard() {
    if (selected == null) return;
    const mine = ++cardToken, id = selected;
    try {
      const c = await api(`/api/admin/payments/${encodeURIComponent(id)}`);
      if (dead || mine !== cardToken) return;
      const sig = JSON.stringify({ ...c, at: 0 });
      card = c;
      if (sig !== cardSig) { cardSig = sig; drawCard(); }
    } catch (ex) {
      if (dead || mine !== cardToken || (ex instanceof ApiError && ex.status === 401)) return;
      card = null;
      side.replaceChildren(el('p', { class: 'adm2-err' }, ex instanceof ApiError && ex.status === 404 ? t('pys.notFound') : t('pys.loadFail')));
    }
  }

  function pick(id) {
    selected = selected === id ? null : id;
    card = null; cardSig = ''; cardToken++;
    history.replaceState(null, '', '#/payments' + (selected ? '/' + selected : ''));
    drawList(); drawCard(); loadCard();
  }

  // ---- refunds (head only; the server checks the role again) ----
  const refreshAfter = async () => { cardSig = ''; await Promise.all([load(), loadCard()]); };
  const run = async (path, body, done, key) => {
    try {
      await api(path, { method: 'POST', key, body });
    } catch (ex) {
      if (ex.code === 'stale' || ex.code === 'refund_in_progress' || ex.code === 'refund_not_allowed') { toast(t('pys.stale'), true); await refreshAfter(); return 'stale'; }
      throw ex;
    }
    toast(done);
    await refreshAfter();
  };

  function askRefund() {
    const p = card.payment, key = newKey();
    return askForm({
      title: t('pys.refundTitle'), lead: t('pys.refundLead', { sum: money(p.amount), name: p.client.name || '—' }), submit: t('pys.refundDo'), danger: true,
      fields: [{ name: 'reason', kind: 'area', label: t('pys.reason'), required: true }],
      run: async v => {
        try {
          await api(`/api/admin/payments/${p.id}/refund`, { method: 'POST', key, body: { reason: v.reason } });
        } catch (ex) {
          if (ex.code === 'refund_in_progress' || ex.code === 'refund_not_allowed') { toast(t('pys.stale'), true); await refreshAfter(); return 'stale'; }
          throw ex;
        }
        toast(t('pys.refundStarted'));
        await refreshAfter();
      }
    });
  }

  function askRetry() {
    const p = card.payment, id = card.retryRefundId, key = newKey();
    return askForm({
      title: t('pys.retryTitle'), lead: t('pys.retryLead', { sum: money(p.amount) }), submit: t('pys.retryDo'), danger: true,
      run: () => run(`/api/admin/refunds/${id}/retry`, {}, t('pys.retryStarted'), key)
    });
  }

  const poll = () => { if (!dead) { load(); loadCard(); } };
  const onVisible = () => { if (!document.hidden) poll(); };
  document.addEventListener('visibilitychange', onVisible);
  timer = setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);

  drawFilters(); drawList(); drawCard();
  load(); loadCard();
  return () => { dead = true; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); document.body.classList.remove('adm2-card-open'); };
}
