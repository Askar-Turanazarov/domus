// «Система» (12 §10, 06 §9.3, §11), head only. Two tabs: the settings with their rules (a save per key; a stale form is replaced by the current value),
// and the services with the AI providers — the demo switches, who answers now, the counters of the day, «reset» of a provider's state.
import { api, ApiError, newKey } from '../api.js';
import { el, toast, dateTime } from '../ui.js';
import { t, addTexts } from '../i18n.js';
import { label } from './common.js';

addTexts({
  ru: { 'nav.system': 'Система', 'sys.title': 'Система', 'sys.tab.settings': 'Настройки', 'sys.tab.services': 'Сервисы и ИИ', 'sys.refresh': 'Обновить',
    'sys.lead': 'Изменения действуют на новые удержания и брони', 'sys.save': 'Сохранить', 'sys.saved': 'Сохранено', 'sys.stale': 'Настройку уже изменили — показано актуальное значение',
    'sys.loadFail': 'Не удалось загрузить данные', 'sys.viewOnly': 'Только просмотр: меняется вместе с файлами в репозитории', 'sys.by': 'Изменил: {name}, {time}', 'sys.default': 'Значение по умолчанию',
    'sys.k.deposit_amount': 'Депозит, сум', 'sys.k.hold_minutes': 'Удержание, минут', 'sys.k.booking_hours': 'Срок брони, часов', 'sys.k.max_active_bookings': 'Активных броней у клиента',
    'sys.k.installment': 'Рассрочка', 'sys.k.furniture_prepay_pct': 'Предоплата мебели, %', 'sys.k.reminders': 'Напоминания', 'sys.k.extend_max_hours': 'Максимум одного продления, часов',
    'sys.k.chat_limits': 'Лимиты чата', 'sys.k.offer_version': 'Версия оферты', 'sys.k.bank_requisites': 'Банковские реквизиты (учебные)',
    'sys.minDown': 'Первый взнос, %', 'sys.months': 'Месяцев', 'sys.markup': 'Наценка, %', 'sys.addTerm': 'Добавить срок', 'sys.removeTerm': 'Убрать срок',
    'sys.bookingBefore': 'За сколько часов до конца брони напоминать (через запятую)', 'sys.viewingBefore': 'За сколько часов до просмотра',
    'sys.perMinute': 'В минуту', 'sys.perDay': 'В сутки', 'sys.perConversation': 'В диалоге',
    'sys.services': 'Сервисы', 'sys.db': 'База', 'sys.qstash': 'Задачи (QStash)', 'sys.telegram': 'Telegram', 'sys.stripe': 'Stripe', 'sys.click': 'Click', 'sys.version': 'Версия',
    'sys.webhook': 'Вебхук Telegram', 'sys.webhookErr': 'Последняя ошибка: {e}', 'sys.webhookStuck': 'Зависших обновлений: {n}', 'sys.webhookOk': 'Без ошибок',
    'sys.jobs': 'Задачи в очереди', 'sys.jobsLate': 'опоздали: {n}', 'sys.outbox': 'Outbox', 'sys.outboxLine': 'ждут: {w}, не доставлено: {f}', 'sys.keys': 'Ключи',
    'sys.key.gemini': 'Gemini: есть', 'sys.key.anthropic': 'Claude: есть', 'sys.nokey.gemini': 'Gemini: нет', 'sys.nokey.anthropic': 'Claude: нет',
    'sys.st.ok': 'Работает', 'sys.st.off': 'Выключено', 'sys.st.test': 'Тестовый режим', 'sys.st.emulator': 'Эмулятор', 'sys.st.live': 'Рабочий', 'sys.st.not_configured': 'Не настроено', 'sys.st.degraded': 'Есть задержки',
    'sys.st.down': 'Недоступно', 'sys.st.migration_needed': 'Нужна миграция', 'sys.st.cooldown': 'Пауза', 'sys.st.disabled': 'Отключено',
    'sys.ai': 'ИИ', 'sys.now': 'Сейчас отвечает', 'sys.mode.primary': 'основная', 'sys.mode.reserve': 'резерв', 'sys.mode.scripts': 'сценарии без ИИ',
    'sys.role.tools': 'Диалог и поиск', 'sys.role.fast': 'Быстрая модель', 'sys.embeddings': 'Поиск по базе знаний', 'sys.emb.ok': 'по смыслу', 'sys.emb.keywords': 'по ключевым словам',
    'sys.geminiOff': 'Отключить Gemini (демонстрация резерва)', 'sys.primaryOff': 'Отключить основную модель', 'sys.geminiOffNote': 'Gemini отключён вручную (демо)',
    'sys.noReserve': 'Резерва нет: ответы перейдут на сценарии', 'sys.tier': 'Уровень ключа Gemini', 'sys.tier.free': 'free', 'sys.tier.paid': 'paid',
    'sys.col.model': 'Модель', 'sys.col.status': 'Статус', 'sys.col.until': 'До', 'sys.col.reason': 'Причина', 'sys.col.today': 'Сегодня', 'sys.reset': 'Сбросить состояние', 'sys.resetDone': 'Состояние сброшено',
    'sys.spent': 'Расход Claude сегодня: ${spent} из ${budget}' },
  en: { 'nav.system': 'System', 'sys.title': 'System', 'sys.tab.settings': 'Settings', 'sys.tab.services': 'Services and AI', 'sys.refresh': 'Refresh',
    'sys.lead': 'Changes apply to new holds and bookings', 'sys.save': 'Save', 'sys.saved': 'Saved', 'sys.stale': 'The setting was changed meanwhile — the current value is shown',
    'sys.loadFail': 'Could not load the data', 'sys.viewOnly': 'View only: changes together with the repository files', 'sys.by': 'Changed by {name}, {time}', 'sys.default': 'Default value',
    'sys.k.deposit_amount': 'Deposit, UZS', 'sys.k.hold_minutes': 'Hold, minutes', 'sys.k.booking_hours': 'Booking term, hours', 'sys.k.max_active_bookings': 'Active bookings per client',
    'sys.k.installment': 'Installment', 'sys.k.furniture_prepay_pct': 'Furniture prepayment, %', 'sys.k.reminders': 'Reminders', 'sys.k.extend_max_hours': 'Longest single extension, hours',
    'sys.k.chat_limits': 'Chat limits', 'sys.k.offer_version': 'Offer version', 'sys.k.bank_requisites': 'Bank details (training)',
    'sys.minDown': 'Down payment, %', 'sys.months': 'Months', 'sys.markup': 'Markup, %', 'sys.addTerm': 'Add a term', 'sys.removeTerm': 'Remove the term',
    'sys.bookingBefore': 'Hours before the booking ends to remind (comma separated)', 'sys.viewingBefore': 'Hours before a viewing',
    'sys.perMinute': 'Per minute', 'sys.perDay': 'Per day', 'sys.perConversation': 'Per conversation',
    'sys.services': 'Services', 'sys.db': 'Database', 'sys.qstash': 'Jobs (QStash)', 'sys.telegram': 'Telegram', 'sys.stripe': 'Stripe', 'sys.click': 'Click', 'sys.version': 'Version',
    'sys.webhook': 'Telegram webhook', 'sys.webhookErr': 'Last error: {e}', 'sys.webhookStuck': 'Stuck updates: {n}', 'sys.webhookOk': 'No errors',
    'sys.jobs': 'Queued jobs', 'sys.jobsLate': 'late: {n}', 'sys.outbox': 'Outbox', 'sys.outboxLine': 'waiting: {w}, not delivered: {f}', 'sys.keys': 'Keys',
    'sys.key.gemini': 'Gemini: set', 'sys.key.anthropic': 'Claude: set', 'sys.nokey.gemini': 'Gemini: missing', 'sys.nokey.anthropic': 'Claude: missing',
    'sys.st.ok': 'Working', 'sys.st.off': 'Off', 'sys.st.test': 'Test mode', 'sys.st.emulator': 'Emulator', 'sys.st.live': 'Live', 'sys.st.not_configured': 'Not configured', 'sys.st.degraded': 'Delays',
    'sys.st.down': 'Down', 'sys.st.migration_needed': 'Migration needed', 'sys.st.cooldown': 'Paused', 'sys.st.disabled': 'Disabled',
    'sys.ai': 'AI', 'sys.now': 'Answering now', 'sys.mode.primary': 'primary', 'sys.mode.reserve': 'reserve', 'sys.mode.scripts': 'scripted answers, no AI',
    'sys.role.tools': 'Dialogue and search', 'sys.role.fast': 'Fast model', 'sys.embeddings': 'Knowledge base search', 'sys.emb.ok': 'by meaning', 'sys.emb.keywords': 'by keywords',
    'sys.geminiOff': 'Turn Gemini off (reserve demo)', 'sys.primaryOff': 'Turn the primary model off', 'sys.geminiOffNote': 'Gemini is turned off by hand (demo)',
    'sys.noReserve': 'No reserve: answers will fall back to scripts', 'sys.tier': 'Gemini key tier', 'sys.tier.free': 'free', 'sys.tier.paid': 'paid',
    'sys.col.model': 'Model', 'sys.col.status': 'Status', 'sys.col.until': 'Until', 'sys.col.reason': 'Reason', 'sys.col.today': 'Today', 'sys.reset': 'Reset state', 'sys.resetDone': 'State reset',
    'sys.spent': 'Claude spent today: ${spent} of ${budget}' },
  uz: { 'nav.system': 'Tizim', 'sys.title': 'Tizim', 'sys.tab.settings': 'Sozlamalar', 'sys.tab.services': 'Xizmatlar va AI', 'sys.refresh': 'Yangilash',
    'sys.lead': 'O‘zgarishlar yangi ushlab turish va bronlarga amal qiladi', 'sys.save': 'Saqlash', 'sys.saved': 'Saqlandi', 'sys.stale': 'Sozlama o‘zgargan — joriy qiymat ko‘rsatildi',
    'sys.loadFail': 'Ma’lumotlarni yuklab bo‘lmadi', 'sys.viewOnly': 'Faqat ko‘rish: repozitoriy fayllari bilan birga o‘zgaradi', 'sys.by': 'O‘zgartirdi: {name}, {time}', 'sys.default': 'Standart qiymat',
    'sys.k.deposit_amount': 'Depozit, so‘m', 'sys.k.hold_minutes': 'Ushlab turish, daqiqa', 'sys.k.booking_hours': 'Bron muddati, soat', 'sys.k.max_active_bookings': 'Mijozning faol bronlari',
    'sys.k.installment': 'Bo‘lib to‘lash', 'sys.k.furniture_prepay_pct': 'Mebel uchun oldindan to‘lov, %', 'sys.k.reminders': 'Eslatmalar', 'sys.k.extend_max_hours': 'Bir marta uzaytirish, soat (eng ko‘pi)',
    'sys.k.chat_limits': 'Chat limitlari', 'sys.k.offer_version': 'Oferta versiyasi', 'sys.k.bank_requisites': 'Bank rekvizitlari (o‘quv)',
    'sys.minDown': 'Boshlang‘ich to‘lov, %', 'sys.months': 'Oy', 'sys.markup': 'Ustama, %', 'sys.addTerm': 'Muddat qo‘shish', 'sys.removeTerm': 'Muddatni olib tashlash',
    'sys.bookingBefore': 'Bron tugashiga necha soat qolganda eslatish (vergul bilan)', 'sys.viewingBefore': 'Ko‘rikdan necha soat oldin',
    'sys.perMinute': 'Daqiqada', 'sys.perDay': 'Kunda', 'sys.perConversation': 'Suhbatda',
    'sys.services': 'Xizmatlar', 'sys.db': 'Baza', 'sys.qstash': 'Vazifalar (QStash)', 'sys.telegram': 'Telegram', 'sys.stripe': 'Stripe', 'sys.click': 'Click', 'sys.version': 'Versiya',
    'sys.webhook': 'Telegram vebhuki', 'sys.webhookErr': 'Oxirgi xato: {e}', 'sys.webhookStuck': 'Qotib qolgan yangilanishlar: {n}', 'sys.webhookOk': 'Xatosiz',
    'sys.jobs': 'Navbatdagi vazifalar', 'sys.jobsLate': 'kechikkan: {n}', 'sys.outbox': 'Outbox', 'sys.outboxLine': 'kutmoqda: {w}, yetkazilmagan: {f}', 'sys.keys': 'Kalitlar',
    'sys.key.gemini': 'Gemini: bor', 'sys.key.anthropic': 'Claude: bor', 'sys.nokey.gemini': 'Gemini: yo‘q', 'sys.nokey.anthropic': 'Claude: yo‘q',
    'sys.st.ok': 'Ishlayapti', 'sys.st.off': 'O‘chirilgan', 'sys.st.test': 'Test rejimi', 'sys.st.emulator': 'Emulyator', 'sys.st.live': 'Ishchi', 'sys.st.not_configured': 'Sozlanmagan', 'sys.st.degraded': 'Kechikishlar',
    'sys.st.down': 'Mavjud emas', 'sys.st.migration_needed': 'Migratsiya kerak', 'sys.st.cooldown': 'Pauza', 'sys.st.disabled': 'O‘chirilgan',
    'sys.ai': 'AI', 'sys.now': 'Hozir javob beradi', 'sys.mode.primary': 'asosiy', 'sys.mode.reserve': 'zaxira', 'sys.mode.scripts': 'AIsiz ssenariylar',
    'sys.role.tools': 'Suhbat va qidiruv', 'sys.role.fast': 'Tezkor model', 'sys.embeddings': 'Bilimlar bazasida qidiruv', 'sys.emb.ok': 'ma’no bo‘yicha', 'sys.emb.keywords': 'kalit so‘zlar bo‘yicha',
    'sys.geminiOff': 'Gemini’ni o‘chirish (zaxira namoyishi)', 'sys.primaryOff': 'Asosiy modelni o‘chirish', 'sys.geminiOffNote': 'Gemini qo‘lda o‘chirilgan (demo)',
    'sys.noReserve': 'Zaxira yo‘q: javoblar ssenariylarga o‘tadi', 'sys.tier': 'Gemini kaliti darajasi', 'sys.tier.free': 'free', 'sys.tier.paid': 'paid',
    'sys.col.model': 'Model', 'sys.col.status': 'Holat', 'sys.col.until': 'Qadar', 'sys.col.reason': 'Sabab', 'sys.col.today': 'Bugun', 'sys.reset': 'Holatni tiklash', 'sys.resetDone': 'Holat tiklandi',
    'sys.spent': 'Bugun Claude sarfi: ${spent} / ${budget}' }
});

const POLL_MS = 10_000;
const TABS = ['settings', 'services'];
const SCALARS = ['deposit_amount', 'hold_minutes', 'booking_hours', 'max_active_bookings', 'furniture_prepay_pct', 'extend_max_hours'];
const usd = v => `$${Number(v ?? 0).toFixed(2)}`;

export function mount(root, { params }) {
  const S = { tab: TABS.includes(params[0]) ? params[0] : 'settings' };
  let items = null, system = null, dead = false, timer;

  const bar = el('div', { class: 'adm2-tabs', role: 'tablist' });
  const body = el('div', {});
  root.replaceChildren(el('h1', { class: 'adm2-h1' }, t('sys.title')), bar, body);

  const fail = ex => { if (!dead && !(ex instanceof ApiError && ex.status === 401)) toast(t('sys.loadFail'), true); };
  const kv = (k, ...v) => el('div', { class: 'adm2-kv' }, el('span', {}, k), el('b', {}, ...v));
  const badge = (status, cls) => el('span', { class: 'adm2-badge ' + (cls ?? (status === 'ok' || status === 'test' || status === 'emulator' || status === 'live' ? 'ob-sent' : status === 'off' || status === 'not_configured' ? '' : 'ob-failed')) }, label('sys.st.', status));

  function drawTabs() {
    bar.replaceChildren(...TABS.map(k => el('button', { type: 'button', role: 'tab', class: 'btn sm' + (S.tab === k ? ' primary' : ' ghost'), dataset: { tab: k }, 'aria-selected': String(S.tab === k),
      on: { click: () => go(k) } }, t('sys.tab.' + k))), el('button', { type: 'button', class: 'btn ghost sm', dataset: { act: 'refresh' }, on: { click: () => reload() } }, t('sys.refresh')));
  }
  function go(k) { S.tab = k; history.replaceState(null, '', `#/system/${k}`); drawTabs(); draw(); reload(); }
  const draw = () => (S.tab === 'settings' ? drawSettings() : drawServices());
  async function reload() {
    try {
      if (S.tab === 'settings') items = Object.fromEntries((await api('/api/admin/settings')).items.map(i => [i.key, i]));
      else {
        const [s, sys] = await Promise.all([api('/api/admin/settings'), api('/api/admin/system')]);
        items = Object.fromEntries(s.items.map(i => [i.key, i])); system = sys;
      }
    } catch (ex) { fail(ex); return; }
    if (!dead) draw();
  }

  // ---- settings ----
  const num = v => el('input', { type: 'number', value: String(v ?? ''), step: 'any' });
  const field = (text, input) => el('label', { class: 'adm2-field' }, el('span', {}, text), input);

  // One form per key: build() → { node, read() }; read gives the value to save.
  function form(key) {
    const v = items[key].value;
    if (SCALARS.includes(key)) {
      const input = num(v);
      return { node: field(t('sys.k.' + key), input), read: () => Number(input.value) };
    }
    if (key === 'installment') {
      const down = num(v.minDownPct);
      const list = el('div', { class: 'adm2-terms' });
      const addRow = (term = { months: 12, markupPct: 0 }) => {
        const months = num(term.months), markup = num(term.markupPct);
        const row = el('div', { class: 'adm2-filters', dataset: { term: '1' } }, field(t('sys.months'), months), field(t('sys.markup'), markup),
          el('button', { type: 'button', class: 'btn ghost sm', on: { click: () => row.remove() } }, t('sys.removeTerm')));
        row.read = () => ({ months: Number(months.value), markupPct: Number(markup.value) });
        list.append(row);
      };
      v.terms.forEach(addRow);
      return { node: el('div', {}, field(t('sys.minDown'), down), list, el('button', { type: 'button', class: 'btn ghost sm', dataset: { act: 'add-term' }, on: { click: () => addRow() } }, t('sys.addTerm'))),
        read: () => ({ minDownPct: Number(down.value), terms: [...list.children].map(r => r.read()) }) };
    }
    if (key === 'reminders') {
      const before = el('input', { type: 'text', value: v.bookingHoursBefore.join(', ') }), view = num(v.viewingHoursBefore);
      return { node: el('div', {}, field(t('sys.bookingBefore'), before), field(t('sys.viewingBefore'), view)),
        read: () => ({ bookingHoursBefore: before.value.split(',').map(x => x.trim()).filter(Boolean).map(Number), viewingHoursBefore: Number(view.value) }) };
    }
    if (key === 'chat_limits') {
      const f = Object.fromEntries(['perMinute', 'perDay', 'perConversation'].map(k => [k, num(v[k])]));
      return { node: el('div', { class: 'adm2-filters' }, Object.entries(f).map(([k, input]) => field(t('sys.' + k), input))),
        read: () => Object.fromEntries(Object.entries(f).map(([k, input]) => [k, Number(input.value)])) };
    }
    return null;
  }

  async function save(key, value, redraw) {
    try {
      const r = await api('/api/admin/settings/' + encodeURIComponent(key), { method: 'PUT', body: { value, expectedUpdatedAt: items[key].updatedAt } });
      items[key] = r.item;
      toast(t('sys.saved'));
    } catch (ex) {
      if (ex instanceof ApiError && ex.code === 'stale') { items[key] = ex.vars.current ?? items[key]; toast(t('sys.stale'), true); }
      else { if (!(ex instanceof ApiError && ex.status === 401)) toast(ex.message || t('sys.loadFail'), true); return; }   // the form stays as typed
    }
    if (!dead) redraw();
  }

  const editor = i => el('small', {}, i.updatedBy ? t('sys.by', { name: i.updatedBy, time: dateTime(i.updatedAt) }) : t('sys.default'));

  function settingBlock(key) {
    const i = items[key];
    if (!i.editable) {
      const value = key === 'bank_requisites' ? Object.entries(i.value).map(([k, x]) => kv(k, x)) : [kv(t('sys.k.' + key), String(i.value))];
      return el('fieldset', { class: 'adm2-demo', dataset: { setting: key } }, el('legend', {}, t('sys.k.' + key)), value, el('small', {}, t('sys.viewOnly')));
    }
    const f = form(key);
    return el('fieldset', { class: 'adm2-demo', dataset: { setting: key } }, el('legend', {}, t('sys.k.' + key)), f.node,
      el('div', { class: 'adm2-modal-actions' }, editor(i),
        el('button', { type: 'button', class: 'btn primary sm', dataset: { act: 'save', key }, on: { click: () => save(key, f.read(), drawSettings) } }, t('sys.save'))));
  }

  function drawSettings() {
    if (!items) return;
    body.replaceChildren(el('p', { class: 'adm2-muted' }, t('sys.lead')),
      ...[...SCALARS, 'installment', 'reminders', 'chat_limits', 'offer_version', 'bank_requisites'].map(settingBlock));
  }

  // ---- services and AI ----
  async function setSwitch(patch) {
    const now = items.ai.value;
    await save('ai', { ...now, ...patch }, () => { drawServices(); });
    reload();
  }

  async function reset(key) {
    try {
      await api(`/api/admin/ai/providers/${encodeURIComponent(key)}/reset`, { method: 'POST', body: {}, key: newKey() });
      toast(t('sys.resetDone'));
    } catch (ex) { if (!(ex instanceof ApiError && ex.status === 401)) toast(ex.message || t('sys.loadFail'), true); }
    reload();
  }

  const stateRow = (key, name, m) => el('tr', { dataset: { key } },
    el('td', {}, name), el('td', {}, badge(m.status, m.status === 'cooldown' ? 'ai-reserve' : undefined)), el('td', {}, m.until ? dateTime(m.until) : '—'), el('td', {}, m.reason ?? '—'),
    el('td', {}, m.limit != null ? `${m.today} / ${m.limit}` : '—'),
    el('td', {}, m.status !== 'ok' && el('button', { type: 'button', class: 'btn ghost sm', dataset: { act: 'reset', key }, on: { click: () => reset(key) } }, t('sys.reset'))));

  function drawServices() {
    if (!system || !items) return;
    const { services: s, ai } = system;
    const sw = items.ai.value;
    const checkbox = (name, text, checked) => el('label', { class: 'adm2-radio' },
      el('input', { type: 'checkbox', name, checked, on: { change: e => setSwitch({ [name]: e.target.checked }) } }), ' ', text);
    const tier = el('select', { name: 'geminiTier', on: { change: e => setSwitch({ geminiTier: e.target.value }) } },
      ['free', 'paid'].map(v => el('option', { value: v, selected: sw.geminiTier === v }, t('sys.tier.' + v))));
    const rows = [];
    for (const [p, info] of Object.entries(ai.providers)) {
      rows.push(stateRow(p, p, info));
      for (const [name, m] of Object.entries(info.models)) rows.push(stateRow(`${p}:${name}`, '  ' + name, m));
    }
    body.replaceChildren(
      el('h2', {}, t('sys.services')),
      el('div', { class: 'adm2-demo', dataset: { part: 'services' } },
        kv(t('sys.db'), badge(s.db)), kv(t('sys.qstash'), badge(s.qstash)), kv(t('sys.telegram'), badge(s.telegram)), kv(t('sys.stripe'), badge(s.stripe)),
        kv(t('sys.click'), badge(s.click)), kv(t('sys.version'), s.version || '—'),
        kv(t('sys.webhook'), s.telegramWebhook.lastError ? t('sys.webhookErr', { e: s.telegramWebhook.lastError }) : t('sys.webhookOk'), s.telegramWebhook.stuck ? ` · ${t('sys.webhookStuck', { n: s.telegramWebhook.stuck })}` : ''),
        kv(t('sys.jobs'), `${s.jobs.scheduled}`, s.jobs.late ? ` · ${t('sys.jobsLate', { n: s.jobs.late })}` : ''),
        kv(t('sys.outbox'), t('sys.outboxLine', { w: s.outbox.waiting, f: s.outbox.failed })),
        kv(t('sys.keys'), ['gemini', 'anthropic'].map(p => t(s.keys[p] ? 'sys.key.' + p : 'sys.nokey.' + p)).join('; '))),
      el('h2', {}, t('sys.ai')),
      el('div', { class: 'adm2-demo', dataset: { part: 'ai' } },
        ['tools', 'fast'].map(role => kv(t('sys.role.' + role), ai.answering[role].model ? `${ai.answering[role].model} (${t('sys.mode.' + ai.answering[role].mode)})` : t('sys.mode.scripts'))),
        kv(t('sys.embeddings'), t('sys.emb.' + ai.embeddings)),
        el('p', { class: 'adm2-muted' }, usdLine(ai)),
        ai.providers.gemini.demoDisabled && el('p', { class: 'adm2-muted', dataset: { part: 'gemini-off' } }, t('sys.geminiOffNote')),
        checkbox('geminiDisabled', t('sys.geminiOff'), Boolean(sw.geminiDisabled)),
        (sw.geminiDisabled || sw.primaryDisabled) && !ai.reserveKey && el('p', { class: 'adm2-muted', dataset: { part: 'no-reserve' } }, t('sys.noReserve')),
        checkbox('primaryDisabled', t('sys.primaryOff'), Boolean(sw.primaryDisabled)),
        field(t('sys.tier'), tier)),
      el('div', { class: 'adm2-tablewrap' }, el('table', { class: 'adm2-table' },
        el('thead', {}, el('tr', {}, ['model', 'status', 'until', 'reason', 'today'].map(c => el('th', {}, t('sys.col.' + c))), el('th', {}))), el('tbody', {}, rows))));
  }
  const usdLine = ai => t('sys.spent', { spent: usd(ai.spentTodayUsd).slice(1), budget: usd(ai.budgetUsd).slice(1) });

  drawTabs();
  reload();
  const onVisible = () => { if (!document.hidden && S.tab === 'services') reload(); };
  document.addEventListener('visibilitychange', onVisible);
  timer = setInterval(() => { if (!document.hidden && S.tab === 'services') reload(); }, POLL_MS);
  return () => { dead = true; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
}
