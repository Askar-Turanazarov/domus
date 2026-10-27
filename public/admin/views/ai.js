// AI (12 §8, FR-ADM-09, FR-ADM-13, FR-DSH-07): the journal of agent turns with the tree of one turn, the journal of tool calls (head),
// the costs by day (head) and the knowledge base with «without an answer» and the reindex (head). Managers see their own clients' turns.
import { api, ApiError } from '../api.js';
import { el, toast, dateTime } from '../ui.js';
import { t, addTexts } from '../i18n.js';

addTexts({
  ru: { 'nav.ai': 'ИИ', 'ai.title': 'ИИ', 'ai.tab.runs': 'Журнал агентов', 'ai.tab.tools': 'Инструменты', 'ai.tab.costs': 'Расходы', 'ai.tab.kb': 'База знаний', 'ai.refresh': 'Обновить',
    'ai.f.problem': 'Проблемные', 'ai.f.errors': 'Только ошибки', 'ai.f.fallback': 'Только резерв', 'ai.f.negative': 'Только 👎', 'ai.more': 'Показать ещё', 'ai.empty': 'Ничего нет',
    'ai.col.time': 'Время', 'ai.col.channel': 'Канал', 'ai.col.client': 'Клиент', 'ai.col.agents': 'Агенты', 'ai.col.tools': 'Инструменты', 'ai.col.model': 'Модель', 'ai.col.ms': 'мс', 'ai.col.tokens': 'Токены',
    'ai.col.cost': '$', 'ai.col.result': 'Итог', 'ai.reserve': 'резерв', 'ai.ok': 'ok', 'ai.fail': 'ошибка', 'ai.slow': 'медленно', 'ai.turn': 'Ход', 'ai.dialog': 'Диалог', 'ai.steps': 'Шаги',
    'ai.firstEvent': 'до первого события {n} мс', 'ai.noteLabel': 'Что не так', 'ai.callsOf': 'Вызовы модели', 'ai.toolsOf': 'Инструменты', 'ai.otherTools': 'Прочие вызовы инструментов',
    'ai.src': 'Источник', 'ai.tool': 'Инструмент', 'ai.result': 'Итог', 'ai.all': 'Все', 'ai.onlyOk': 'Успешные', 'ai.onlyFail': 'Отказы', 'ai.args': 'Аргументы', 'ai.error': 'Ошибка',
    'ai.today': 'Сегодня: {spent} из {budget} (платный Claude)', 'ai.geminiToday': 'Запросы Gemini сегодня', 'ai.tier': 'Уровень Gemini: {tier}', 'ai.tier.free': 'бесплатный', 'ai.tier.paid': 'платный',
    'ai.day': 'День', 'ai.calls': 'Вызовов', 'ai.in': 'Вход', 'ai.out': 'Выход', 'ai.cached': 'Кэш', 'ai.byModel': 'По моделям', 'ai.fbShare': 'Резерв', 'ai.total': 'Итого за период: {calls} вызовов, {cost}',
    'ai.kb.lang': 'Язык', 'ai.kb.topic': 'Тема', 'ai.kb.chunks': 'Фрагменты', 'ai.kb.file': 'Файл', 'ai.kb.heading': 'Заголовок', 'ai.kb.len': 'Длина', 'ai.kb.hash': 'Хеш', 'ai.kb.indexed': 'Дата документа',
    'ai.kb.vector': 'Вектор', 'ai.kb.noVector': 'нет вектора', 'ai.kb.reindex': 'Переиндексировать', 'ai.kb.reindexing': 'Идёт…', 'ai.kb.noKey': 'Нет ключа Gemini: переиндексация недоступна',
    'ai.kb.reindexed': 'Изменено {changed} фрагментов из {total}, удалено {deleted}', 'ai.kb.partial': 'У части фрагментов нет векторов: поиск пока только по словам',
    'ai.kb.unanswered': 'Без ответа', 'ai.kb.unansweredLead': 'Вопросы, на которые консультант честно отказал, за {days} дн. Подсказка, что дописать в базу.', 'ai.kb.copy': 'Скопировать список',
    'ai.kb.copied': 'Список скопирован', 'ai.kb.keywordOnly': 'Отказов из-за недоступных эмбеддингов (не пробел базы): {n}', 'ai.kb.repeats': '×{n}', 'ai.loadFail': 'Не удалось загрузить', 'ai.notFound': 'Хода нет или он не ваш' },
  en: { 'nav.ai': 'AI', 'ai.title': 'AI', 'ai.tab.runs': 'Agent journal', 'ai.tab.tools': 'Tools', 'ai.tab.costs': 'Costs', 'ai.tab.kb': 'Knowledge base', 'ai.refresh': 'Refresh',
    'ai.f.problem': 'Problematic', 'ai.f.errors': 'Errors only', 'ai.f.fallback': 'Reserve only', 'ai.f.negative': '👎 only', 'ai.more': 'Show more', 'ai.empty': 'Nothing here',
    'ai.col.time': 'Time', 'ai.col.channel': 'Channel', 'ai.col.client': 'Client', 'ai.col.agents': 'Agents', 'ai.col.tools': 'Tools', 'ai.col.model': 'Model', 'ai.col.ms': 'ms', 'ai.col.tokens': 'Tokens',
    'ai.col.cost': '$', 'ai.col.result': 'Result', 'ai.reserve': 'reserve', 'ai.ok': 'ok', 'ai.fail': 'error', 'ai.slow': 'slow', 'ai.turn': 'Turn', 'ai.dialog': 'Dialogue', 'ai.steps': 'Steps',
    'ai.firstEvent': 'first event after {n} ms', 'ai.noteLabel': 'What is wrong', 'ai.callsOf': 'Model calls', 'ai.toolsOf': 'Tools', 'ai.otherTools': 'Other tool calls',
    'ai.src': 'Source', 'ai.tool': 'Tool', 'ai.result': 'Result', 'ai.all': 'All', 'ai.onlyOk': 'Successful', 'ai.onlyFail': 'Failures', 'ai.args': 'Arguments', 'ai.error': 'Error',
    'ai.today': 'Today: {spent} of {budget} (paid Claude)', 'ai.geminiToday': 'Gemini requests today', 'ai.tier': 'Gemini tier: {tier}', 'ai.tier.free': 'free', 'ai.tier.paid': 'paid',
    'ai.day': 'Day', 'ai.calls': 'Calls', 'ai.in': 'Input', 'ai.out': 'Output', 'ai.cached': 'Cached', 'ai.byModel': 'By model', 'ai.fbShare': 'Reserve', 'ai.total': 'Total for the period: {calls} calls, {cost}',
    'ai.kb.lang': 'Language', 'ai.kb.topic': 'Topic', 'ai.kb.chunks': 'Chunks', 'ai.kb.file': 'File', 'ai.kb.heading': 'Heading', 'ai.kb.len': 'Length', 'ai.kb.hash': 'Hash', 'ai.kb.indexed': 'Document date',
    'ai.kb.vector': 'Vector', 'ai.kb.noVector': 'no vector', 'ai.kb.reindex': 'Reindex', 'ai.kb.reindexing': 'Working…', 'ai.kb.noKey': 'No Gemini key: reindexing is unavailable',
    'ai.kb.reindexed': 'Changed {changed} chunks of {total}, removed {deleted}', 'ai.kb.partial': 'Some chunks have no vectors: search works by words only for now',
    'ai.kb.unanswered': 'Without an answer', 'ai.kb.unansweredLead': 'Questions the consultant honestly refused, last {days} days. A hint for what to add to the base.', 'ai.kb.copy': 'Copy the list',
    'ai.kb.copied': 'List copied', 'ai.kb.keywordOnly': 'Refusals because embeddings were unavailable (not a gap of the base): {n}', 'ai.kb.repeats': '×{n}', 'ai.loadFail': 'Could not load', 'ai.notFound': 'No such turn, or it is not yours' },
  uz: { 'nav.ai': 'AI', 'ai.title': 'AI', 'ai.tab.runs': 'Agentlar jurnali', 'ai.tab.tools': 'Asboblar', 'ai.tab.costs': 'Xarajatlar', 'ai.tab.kb': 'Bilimlar bazasi', 'ai.refresh': 'Yangilash',
    'ai.f.problem': 'Muammoli', 'ai.f.errors': 'Faqat xatolar', 'ai.f.fallback': 'Faqat zaxira', 'ai.f.negative': 'Faqat 👎', 'ai.more': 'Yana ko‘rsatish', 'ai.empty': 'Hech narsa yo‘q',
    'ai.col.time': 'Vaqt', 'ai.col.channel': 'Kanal', 'ai.col.client': 'Mijoz', 'ai.col.agents': 'Agentlar', 'ai.col.tools': 'Asboblar', 'ai.col.model': 'Model', 'ai.col.ms': 'ms', 'ai.col.tokens': 'Tokenlar',
    'ai.col.cost': '$', 'ai.col.result': 'Natija', 'ai.reserve': 'zaxira', 'ai.ok': 'ok', 'ai.fail': 'xato', 'ai.slow': 'sekin', 'ai.turn': 'Navbat', 'ai.dialog': 'Muloqot', 'ai.steps': 'Qadamlar',
    'ai.firstEvent': 'birinchi hodisagacha {n} ms', 'ai.noteLabel': 'Nima noto‘g‘ri', 'ai.callsOf': 'Model chaqiruvlari', 'ai.toolsOf': 'Asboblar', 'ai.otherTools': 'Boshqa asbob chaqiruvlari',
    'ai.src': 'Manba', 'ai.tool': 'Asbob', 'ai.result': 'Natija', 'ai.all': 'Hammasi', 'ai.onlyOk': 'Muvaffaqiyatli', 'ai.onlyFail': 'Rad etilgan', 'ai.args': 'Argumentlar', 'ai.error': 'Xato',
    'ai.today': 'Bugun: {spent} / {budget} (pullik Claude)', 'ai.geminiToday': 'Bugungi Gemini so‘rovlari', 'ai.tier': 'Gemini darajasi: {tier}', 'ai.tier.free': 'bepul', 'ai.tier.paid': 'pullik',
    'ai.day': 'Kun', 'ai.calls': 'Chaqiruvlar', 'ai.in': 'Kirish', 'ai.out': 'Chiqish', 'ai.cached': 'Kesh', 'ai.byModel': 'Modellar bo‘yicha', 'ai.fbShare': 'Zaxira', 'ai.total': 'Davr bo‘yicha jami: {calls} chaqiruv, {cost}',
    'ai.kb.lang': 'Til', 'ai.kb.topic': 'Mavzu', 'ai.kb.chunks': 'Parchalar', 'ai.kb.file': 'Fayl', 'ai.kb.heading': 'Sarlavha', 'ai.kb.len': 'Uzunlik', 'ai.kb.hash': 'Xesh', 'ai.kb.indexed': 'Hujjat sanasi',
    'ai.kb.vector': 'Vektor', 'ai.kb.noVector': 'vektor yo‘q', 'ai.kb.reindex': 'Qayta indekslash', 'ai.kb.reindexing': 'Bajarilmoqda…', 'ai.kb.noKey': 'Gemini kaliti yo‘q: qayta indekslash mumkin emas',
    'ai.kb.reindexed': '{total} parchadan {changed} tasi o‘zgardi, {deleted} tasi o‘chirildi', 'ai.kb.partial': 'Ba’zi parchalarda vektor yo‘q: qidiruv hozircha faqat so‘zlar bo‘yicha',
    'ai.kb.unanswered': 'Javobsiz', 'ai.kb.unansweredLead': 'Maslahatchi rad etgan savollar, oxirgi {days} kun. Bazaga nima qo‘shish kerakligi haqida maslahat.', 'ai.kb.copy': 'Ro‘yxatni nusxalash',
    'ai.kb.copied': 'Ro‘yxat nusxalandi', 'ai.kb.keywordOnly': 'Embedding mavjud emasligi sababli rad etishlar (baza kamchiligi emas): {n}', 'ai.kb.repeats': '×{n}', 'ai.loadFail': 'Yuklab bo‘lmadi', 'ai.notFound': 'Bunday navbat yo‘q yoki u sizniki emas' }
});

const usd = v => `$${Number(v).toFixed(v < 1 ? 4 : 2)}`;
const SOURCES = ['agent', 'mcp', 'mcp:head', 'mcp:client'];
const RUN_FLAGS = ['problem', 'errors', 'fallback', 'negative'];

export function mount(root, { staff, params }) {
  const head = staff.role === 'head';
  const tabs = ['runs', ...(head ? ['tools', 'costs'] : []), 'kb'];
  const S = { tab: tabs.includes(params[0]) ? params[0] : 'runs', turn: params[1] || null };
  const R = { flags: new Set(), items: [], next: null, loaded: false, selected: null };
  const T = { source: '', tool: '', ok: '', items: [], next: null, loaded: false };
  const K = { lang: '', topic: '', chunks: null, topics: [], unanswered: null, picked: null, busy: false };
  let costs = null, dead = false, token = 0;

  const bar = el('div', { class: 'adm2-tabs', role: 'tablist' });
  const body = el('div', {});
  const side = el('aside', { class: 'adm2-side', hidden: true });
  root.replaceChildren(el('h1', { class: 'adm2-h1' }, t('ai.title')), bar, el('div', { class: 'adm2-split list' }, body, side));

  const fail = ex => { if (!dead && !(ex instanceof ApiError && ex.status === 401)) toast(t('ai.loadFail'), true); };
  const kv = (k, v) => el('div', { class: 'adm2-kv' }, el('span', {}, k), el('b', {}, v));
  const table = (cols, rows) => el('div', { class: 'adm2-tablewrap' }, rows.length
    ? el('table', { class: 'adm2-table' }, el('thead', {}, el('tr', {}, cols.map(c => el('th', {}, c)))), el('tbody', {}, rows))
    : el('p', { class: 'adm2-empty' }, t('ai.empty')));

  function drawTabs() {
    bar.replaceChildren(...tabs.map(k => el('button', { type: 'button', role: 'tab', class: 'btn sm' + (S.tab === k ? ' primary' : ' ghost'), dataset: { tab: k }, 'aria-selected': String(S.tab === k),
      on: { click: () => go(k) } }, t('ai.tab.' + k))), el('button', { type: 'button', class: 'btn ghost sm', dataset: { act: 'refresh' }, on: { click: () => reload() } }, t('ai.refresh')));
  }
  function go(k) {
    S.tab = k; side.hidden = true; document.body.classList.remove('adm2-card-open');
    history.replaceState(null, '', `#/ai/${k}`);
    drawTabs(); draw(); reload();
  }
  const reload = () => ({ runs: loadRuns, tools: loadTools, costs: loadCosts, kb: loadKb })[S.tab]();
  const draw = () => ({ runs: drawRuns, tools: drawTools, costs: drawCosts, kb: drawKb })[S.tab]();

  // ---- the journal of turns ----
  async function loadRuns({ more = false } = {}) {
    const mine = ++token;
    const qs = new URLSearchParams([...R.flags].map(f => [f, '1']));
    if (more) qs.set('cursor', R.next);
    try {
      const r = await api(`/api/admin/ai/runs?${qs}`);
      if (dead || mine !== token) return;
      R.items = more ? R.items.concat(r.items) : r.items; R.next = r.next; R.loaded = true;
    } catch (ex) { fail(ex); }
    drawRuns();
  }
  function runRow(r) {
    return el('tr', { class: R.selected === r.turnId ? 'sel' : '', tabindex: 0, dataset: { turn: r.turnId }, on: { click: () => pickRun(r.turnId), keydown: e => { if (e.key === 'Enter') pickRun(r.turnId); } } },
      el('td', {}, dateTime(r.at)), el('td', {}, r.channel ?? '—'), el('td', {}, r.client?.name ?? '—'), el('td', {}, r.agents.join(' → ')), el('td', {}, r.tools.join(', ') || '—'),
      el('td', {}, r.model ?? '—', r.fallback && [' ', el('span', { class: 'adm2-badge ai-reserve' }, t('ai.reserve'))]),
      el('td', {}, `${r.ms}`, el('small', {}, r.firstEventMs != null ? `${r.firstEventMs}` : '')), el('td', {}, `${r.tokens.input}/${r.tokens.output}`), el('td', {}, usd(r.costUsd)),
      el('td', {}, el('span', { class: 'adm2-badge ' + (r.ok ? 'ob-sent' : 'ob-failed') }, r.ok ? t('ai.ok') : (r.error ? r.error : t('ai.fail'))), r.error && r.ok && el('small', {}, r.error),
        r.feedback === 1 && ' 👍', r.feedback === -1 && ' 👎'));
  }
  function drawRuns() {
    body.replaceChildren(
      el('div', { class: 'adm2-filters' }, RUN_FLAGS.map(f => el('label', { class: 'adm2-radio' },
        el('input', { type: 'checkbox', name: f, checked: R.flags.has(f), on: { change: e => { if (e.target.checked) R.flags.add(f); else R.flags.delete(f); loadRuns(); } } }), ' ', t('ai.f.' + f)))),
      table(['time', 'channel', 'client', 'agents', 'tools', 'model', 'ms', 'tokens', 'cost', 'result'].map(c => t('ai.col.' + c)), R.items.map(runRow)),
      R.next && el('div', { class: 'adm2-more' }, el('button', { type: 'button', class: 'btn', on: { click: () => loadRuns({ more: true }) } }, t('ai.more'))));
  }
  async function pickRun(id) {
    R.selected = R.selected === id ? null : id;
    history.replaceState(null, '', '#/ai/runs' + (R.selected ? '/' + R.selected : ''));
    drawRuns();
    if (!R.selected) { side.hidden = true; document.body.classList.remove('adm2-card-open'); return; }
    side.hidden = false; document.body.classList.add('adm2-card-open');
    side.replaceChildren(el('p', { class: 'adm2-muted' }, t('app.loading')));
    try {
      const tree = await api(`/api/admin/ai/runs/${encodeURIComponent(id)}`);
      if (dead || R.selected !== id) return;
      drawTree(tree);
    } catch (ex) {
      if (dead || R.selected !== id) return;
      side.replaceChildren(el('p', { class: 'adm2-err' }, ex instanceof ApiError && ex.status === 404 ? t('ai.notFound') : t('ai.loadFail')));
    }
  }
  const toolLine = c => el('li', {}, el('b', {}, c.tool ?? '—'), c.phase && ` (${c.phase})`, ' ', el('span', { class: 'adm2-badge ' + (c.ok ? 'ob-sent' : 'ob-failed') }, c.ok ? t('ai.ok') : (c.error ?? t('ai.fail'))),
    el('small', {}, ` ${c.ms ?? '—'} ${t('ai.col.ms')}`), c.args && el('pre', { class: 'adm2-json' }, JSON.stringify(c.args)));
  function drawTree(tree) {
    side.replaceChildren(
      el('div', { class: 'adm2-side-head' }, el('h2', {}, t('ai.turn')), el('button', { type: 'button', class: 'btn ghost sm', 'aria-label': t('apt.close'), on: { click: () => pickRun(R.selected) } }, '✕')),
      el('div', { class: 'adm2-facts' }, kv(t('ai.col.time'), dateTime(tree.at)), tree.conversation && kv(t('ai.col.channel'), tree.conversation.channel),
        tree.conversation?.client && kv(t('ai.col.client'), tree.conversation.client.name ?? '—')),
      el('section', { class: 'adm2-sec' }, el('h3', {}, t('ai.dialog')), el('ul', { class: 'adm2-feed' }, tree.messages.map(m =>
        el('li', { class: m.role === 'user' ? 'msg-user' : 'msg-assistant' }, el('div', { class: 'adm2-msg' }, m.text), m.feedback === -1 && el('small', {}, ` 👎${m.note ? ' — ' + t('ai.noteLabel') + ': ' + m.note : ''}`), m.feedback === 1 && el('small', {}, ' 👍'))))),
      el('section', { class: 'adm2-sec' }, el('h3', {}, t('ai.steps')), el('ol', { class: 'adm2-tree', dataset: { part: 'tree' } }, tree.steps.map(s =>
        el('li', {}, el('b', {}, s.agent), ' ', el('span', { class: 'adm2-muted' }, `${s.provider ?? '—'} · ${s.model ?? '—'} · ${s.ms ?? '—'} ${t('ai.col.ms')} · ${s.tokens.input}/${s.tokens.output} · ${usd(s.costUsd)}`),
          s.fallback && [' ', el('span', { class: 'adm2-badge ai-reserve' }, t('ai.reserve'))], s.error && [' ', el('span', { class: 'adm2-badge ob-failed' }, s.error)],
          s.firstEventMs != null && el('div', { class: 'adm2-muted' }, t('ai.firstEvent', { n: s.firstEventMs })),
          s.calls.length > 0 && el('ul', { class: 'adm2-list' }, s.calls.map(c => el('li', {}, `${c.kind} · ${c.model} · ${c.ms ?? '—'} ${t('ai.col.ms')} · ${c.tokens.input}/${c.tokens.output}`, c.errorClass && el('span', { class: 'adm2-err' }, ` ${c.errorClass}`)))),
          s.tools.length > 0 && el('ul', { class: 'adm2-list' }, s.tools.map(toolLine))))),
        tree.otherTools.length > 0 && [el('h4', {}, t('ai.otherTools')), el('ul', { class: 'adm2-list' }, tree.otherTools.map(toolLine))]));
  }

  // ---- the journal of tools (head) ----
  async function loadTools({ more = false } = {}) {
    const mine = ++token;
    const qs = new URLSearchParams(Object.entries({ source: T.source, tool: T.tool, ok: T.ok }).filter(([, v]) => v));
    if (more) qs.set('cursor', T.next);
    try {
      const r = await api(`/api/admin/ai/tools?${qs}`);
      if (dead || mine !== token) return;
      T.items = more ? T.items.concat(r.items) : r.items; T.next = r.next; T.loaded = true;
    } catch (ex) { fail(ex); }
    drawTools();
  }
  const srcLabel = c => (c.source === 'mcp' ? `mcp:${c.role ?? '—'}` : `agent${c.agent ? ':' + c.agent : ''}`);
  function drawTools() {
    const sel = (name, caption, options) => el('label', { class: 'adm2-sel' }, el('span', {}, caption),
      el('select', { name, on: { change: e => { T[name] = e.target.value; loadTools(); } } }, el('option', { value: '' }, t('ai.all')),
        options.map(([v, text]) => el('option', { value: v, selected: v === T[name] }, text))));
    body.replaceChildren(
      el('div', { class: 'adm2-filters' }, sel('source', t('ai.src'), SOURCES.map(s => [s, s])), sel('ok', t('ai.result'), [['1', t('ai.onlyOk')], ['0', t('ai.onlyFail')]]),
        el('label', { class: 'adm2-sel' }, el('span', {}, t('ai.tool')), el('input', { type: 'text', name: 'tool', value: T.tool, maxLength: 60, on: { change: e => { T.tool = e.target.value.trim(); loadTools(); } } }))),
      table([t('ai.col.time'), t('ai.src'), t('ai.tool'), t('ai.result'), t('ai.col.ms'), t('ai.args')], T.items.map(c => el('tr', {},
        el('td', {}, dateTime(c.at)), el('td', {}, srcLabel(c)), el('td', {}, c.tool ?? '—', c.phase && el('small', {}, c.phase)),
        el('td', {}, el('span', { class: 'adm2-badge ' + (c.ok ? 'ob-sent' : 'ob-failed') }, c.ok ? t('ai.ok') : (c.error ?? t('ai.fail')))), el('td', {}, String(c.ms ?? '—')),
        el('td', {}, c.args ? el('code', {}, JSON.stringify(c.args)) : '—')))),
      T.next && el('div', { class: 'adm2-more' }, el('button', { type: 'button', class: 'btn', on: { click: () => loadTools({ more: true }) } }, t('ai.more'))));
  }

  // ---- costs (head) ----
  async function loadCosts() {
    const mine = ++token;
    try {
      const r = await api('/api/admin/ai/costs?days=30');
      if (dead || mine !== token) return;
      costs = r;
    } catch (ex) { fail(ex); }
    drawCosts();
  }
  function drawCosts() {
    if (!costs) { body.replaceChildren(el('p', { class: 'adm2-muted' }, t('app.loading'))); return; }
    const c = costs, pct = Math.min(100, (c.today.paidUsd / c.today.budgetUsd) * 100);
    body.replaceChildren(
      el('section', { class: 'adm2-sec' }, el('p', {}, el('b', {}, t('ai.today', { spent: usd(c.today.paidUsd), budget: usd(c.today.budgetUsd) }))),
        el('progress', { class: 'adm2-meter', max: 100, value: Math.round(pct), 'aria-label': t('ai.geminiToday') }),
        el('p', { class: 'adm2-muted' }, t('ai.tier', { tier: t('ai.tier.' + c.geminiTier) }))),
      el('section', { class: 'adm2-sec' }, el('h3', {}, t('ai.geminiToday')), el('ul', { class: 'adm2-list' }, c.today.gemini.map(g =>
        el('li', {}, `${g.model}: ${g.used} / ${g.limit}`)))),
      table([t('ai.day'), t('ai.calls'), t('ai.in'), t('ai.out'), t('ai.cached'), t('ai.col.cost'), t('ai.fbShare'), t('ai.byModel')], c.days.map(d => el('tr', {},
        el('td', {}, d.day), el('td', {}, String(d.calls)), el('td', {}, String(d.input)), el('td', {}, String(d.output)), el('td', {}, String(d.cached)), el('td', {}, usd(d.costUsd)),
        el('td', {}, `${Math.round(d.fallbackShare * 100)}%`), el('td', {}, d.byModel.map(m => `${m.model} ×${m.calls} ${usd(m.costUsd)}`).join('; '))))),
      el('p', { class: 'adm2-total' }, t('ai.total', { calls: c.totals.calls, cost: usd(c.totals.costUsd) })));
  }

  // ---- the knowledge base ----
  async function loadKb() {
    const mine = ++token;
    const qs = new URLSearchParams(Object.entries({ lang: K.lang, topic: K.topic }).filter(([, v]) => v));
    try {
      const [chunks, un] = await Promise.all([api(`/api/admin/kb/chunks?${qs}`), api('/api/admin/kb/unanswered?days=30')]);
      if (dead || mine !== token) return;
      K.chunks = chunks.items; K.topics = chunks.topics; K.unanswered = un;
    } catch (ex) { fail(ex); }
    drawKb();
  }
  async function reindex() {
    K.busy = true; drawKb();
    try {
      const r = await api('/api/admin/kb/reindex', { method: 'POST', body: {} });
      toast(t('ai.kb.reindexed', r));
      if (r.partial) toast(t('ai.kb.partial'), true);
    } catch (ex) { toast(ex.code === 'feature_disabled' ? t('ai.kb.noKey') : (ex.message || t('ai.loadFail')), true); }
    K.busy = false;
    loadKb();
  }
  async function copyList() {
    const text = K.unanswered.groups.map(g => `${g.count > 1 ? `[×${g.count}] ` : ''}(${g.lang}) ${g.query}`).join('\n');
    try { await navigator.clipboard.writeText(text); toast(t('ai.kb.copied')); } catch { /* the list stays on the screen for hand copying */ }
  }
  function drawKb() {
    const sel = (name, caption, options) => el('label', { class: 'adm2-sel' }, el('span', {}, caption),
      el('select', { name, on: { change: e => { K[name] = e.target.value; loadKb(); } } }, el('option', { value: '' }, t('ai.all')),
        options.map(v => el('option', { value: v, selected: v === K[name] }, v))));
    const un = K.unanswered;
    body.replaceChildren(
      el('div', { class: 'adm2-filters' }, sel('lang', t('ai.kb.lang'), ['ru', 'uz', 'en']), sel('topic', t('ai.kb.topic'), K.topics),
        head && el('button', { type: 'button', class: 'btn primary sm', dataset: { act: 'reindex' }, disabled: K.busy, on: { click: reindex } }, K.busy ? t('ai.kb.reindexing') : t('ai.kb.reindex'))),
      K.chunks && table([t('ai.kb.lang'), t('ai.kb.file'), t('ai.kb.heading'), t('ai.kb.len'), t('ai.kb.hash'), t('ai.kb.indexed'), t('ai.kb.vector')], K.chunks.map(c =>
        el('tr', { class: K.picked === c.id ? 'sel' : '', tabindex: 0, dataset: { chunk: c.id }, on: { click: () => pickChunk(c), keydown: e => { if (e.key === 'Enter') pickChunk(c); } } },
          el('td', {}, c.lang), el('td', {}, c.file), el('td', {}, c.heading), el('td', {}, String(c.length)), el('td', {}, el('code', {}, c.hash)), el('td', {}, dateTime(c.indexedAt)),
          el('td', {}, c.hasVector ? '✓' : t('ai.kb.noVector'))))),
      un && el('section', { class: 'adm2-sec', dataset: { block: 'unanswered' } }, el('h3', {}, t('ai.kb.unanswered')), el('p', { class: 'adm2-muted' }, t('ai.kb.unansweredLead', { days: un.days })),
        un.groups.length ? el('ul', { class: 'adm2-list' }, un.groups.map(g => el('li', {}, el('span', { class: 'adm2-badge' }, g.lang), ' ', g.query, g.count > 1 && el('b', {}, ` ${t('ai.kb.repeats', { n: g.count })}`)))) : el('p', { class: 'adm2-empty' }, t('ai.empty')),
        un.groups.length > 0 && el('button', { type: 'button', class: 'btn ghost sm', dataset: { act: 'copy' }, on: { click: copyList } }, t('ai.kb.copy')),
        un.keywordOnly > 0 && el('p', { class: 'adm2-muted' }, t('ai.kb.keywordOnly', { n: un.keywordOnly }))));
  }
  function pickChunk(c) {
    K.picked = K.picked === c.id ? null : c.id;
    if (!K.picked) { side.hidden = true; document.body.classList.remove('adm2-card-open'); drawKb(); return; }
    side.hidden = false; document.body.classList.add('adm2-card-open');
    side.replaceChildren(el('div', { class: 'adm2-side-head' }, el('h2', {}, c.heading), el('button', { type: 'button', class: 'btn ghost sm', 'aria-label': t('apt.close'), on: { click: () => pickChunk(c) } }, '✕')),
      el('p', { class: 'adm2-muted' }, `${c.file} · ${c.lang}`), el('div', { class: 'adm2-msg', dataset: { part: 'chunk-text' } }, c.text));
    drawKb();
  }

  drawTabs(); draw();
  reload();
  if (S.tab === 'runs' && S.turn) pickRun(S.turn);
  return () => { dead = true; document.body.classList.remove('adm2-card-open'); };
}
