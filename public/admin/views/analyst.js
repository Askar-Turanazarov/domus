// «Аналитик» (12 §11, 07 §14, FR-ADM-10), head only: a chat with the read-only analyst over POST /api/admin/analyst (SSE, the
// protocol of the site chat — its stream parser and safe Markdown are reused). The answer is the text and a table from the tool
// result with «Открыть в админке»; no selling buttons, three starter questions.
import { CSRF } from '../api.js';
import { el } from '../ui.js';
import { t, addTexts, getLang } from '../i18n.js';
import { streamChat } from '../../js/chat/stream.js';
import { renderMarkdown } from '../../js/chat/markdown.js';

addTexts({
  ru: { 'nav.analyst': 'Аналитик', 'an.title': 'Аналитик', 'an.lead': 'Отвечает по данным: продажи, воронка, брони, оплаты, показы, ИИ. Только смотрит — изменить ничего не может.',
    'an.q1': 'Какие брони сгорают завтра?', 'an.q2': 'Сравни продажи этой и прошлой недели', 'an.q3': 'Сколько стоил ИИ за неделю?',
    'an.placeholder': 'Спросите о продажах…', 'an.send': 'Отправить', 'an.new': 'Новый диалог', 'an.open': 'Открыть в админке', 'an.total': 'Всего: {n}',
    'an.period': '{from} — {to}', 'an.fail': 'Не удалось получить ответ', 'an.busy': 'Предыдущий ответ ещё готовится' },
  uz: { 'nav.analyst': 'Tahlilchi', 'an.title': 'Tahlilchi', 'an.lead': 'Ma’lumotlar bo‘yicha javob beradi: sotuvlar, voronka, bronlar, to‘lovlar, ko‘riklar, AI. Faqat ko‘radi — hech narsani o‘zgartira olmaydi.',
    'an.q1': 'Ertaga qaysi bronlar kuyadi?', 'an.q2': 'Shu va o‘tgan hafta sotuvlarini solishtir', 'an.q3': 'Bir haftada AI qancha turdi?',
    'an.placeholder': 'Sotuvlar haqida so‘rang…', 'an.send': 'Yuborish', 'an.new': 'Yangi suhbat', 'an.open': 'Admin panelda ochish', 'an.total': 'Jami: {n}',
    'an.period': '{from} — {to}', 'an.fail': 'Javob olib bo‘lmadi', 'an.busy': 'Oldingi javob hali tayyorlanmoqda' },
  en: { 'nav.analyst': 'Analyst', 'an.title': 'Analyst', 'an.lead': 'Answers from the data: sales, funnel, bookings, payments, viewings, AI. It only looks and cannot change anything.',
    'an.q1': 'Which bookings burn tomorrow?', 'an.q2': 'Compare sales of this week and last week', 'an.q3': 'How much did the AI cost this week?',
    'an.placeholder': 'Ask about sales…', 'an.send': 'Send', 'an.new': 'New dialog', 'an.open': 'Open in the admin', 'an.total': 'Total: {n}',
    'an.period': '{from} — {to}', 'an.fail': 'Could not get an answer', 'an.busy': 'The previous answer is still in progress' }
});

// The table block of the analyst: { tool, from?, to?, total?, columns, rows, link? } — all text, never HTML.
export function tableBlock(d, go) {
  const box = el('div', { class: 'an-table' });
  if (d.from) box.append(el('p', { class: 'adm2-muted' }, t('an.period', { from: d.from, to: d.to })));
  box.append(el('div', { class: 'adm2-tablewrap' }, el('table', { class: 'adm2-table' },
    el('thead', {}, el('tr', {}, (d.columns ?? []).map(c => el('th', {}, String(c))))),
    el('tbody', {}, (d.rows ?? []).map(r => el('tr', {}, r.map(c => el('td', {}, String(c)))))))));
  if (d.total != null && d.total > (d.rows ?? []).length) box.append(el('p', { class: 'adm2-total' }, t('an.total', { n: d.total })));
  if (/^#\/[a-z]+$/.test(d.link ?? '')) {
    box.append(el('a', { class: 'btn ghost sm', href: d.link, on: { click: e => { e.preventDefault(); go(d.link.slice(2)); } } }, t('an.open')));
  }
  return box;
}

export function mount(root, { go }) {
  let conversationId = null, busy = false, dead = false, ctrl = null;
  const log = el('div', { class: 'an-log', 'aria-live': 'polite' });
  const input = el('textarea', { class: 'an-input', rows: 2, maxLength: 2000, placeholder: t('an.placeholder'),
    on: { keydown: e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input.value); } } } });
  const send = el('button', { type: 'submit', class: 'btn sm' }, t('an.send'));
  const starters = el('div', { class: 'an-starters' }, ['an.q1', 'an.q2', 'an.q3'].map(k =>
    el('button', { type: 'button', class: 'btn ghost sm', on: { click: () => ask(t(k)) } }, t(k))));
  const fresh = el('button', { type: 'button', class: 'btn ghost sm', on: { click: () => {
    if (busy) return;
    conversationId = null;
    log.replaceChildren();
    starters.hidden = false;
  } } }, t('an.new'));
  root.replaceChildren(el('h1', { class: 'adm2-h1' }, t('an.title')), el('p', { class: 'adm2-muted' }, t('an.lead')), starters, log,
    el('form', { class: 'an-form', on: { submit: e => { e.preventDefault(); ask(input.value); } } }, input, send, fresh));

  async function ask(raw) {
    const text = String(raw ?? '').trim();
    if (!text || dead) return;
    if (busy) { log.append(el('p', { class: 'adm2-muted' }, t('an.busy'))); return; }
    busy = true;
    send.disabled = true;
    starters.hidden = true;
    input.value = '';
    log.append(el('div', { class: 'an-msg user' }, text));
    const status = el('p', { class: 'adm2-muted an-status' });
    const body = el('div', { class: 'an-text' });
    const msg = el('div', { class: 'an-msg bot' }, status, body);
    log.append(msg);
    let said = '';
    const draw = () => body.replaceChildren(renderMarkdown(said));
    ctrl = new AbortController();
    try {
      await streamChat('/api/admin/analyst', { text, lang: getLang(), ...(conversationId ? { conversationId } : {}) }, ev => {
        const d = ev.data ?? {};
        if (ev.event === 'meta') conversationId = d.conversationId;
        else if (ev.event === 'status') status.textContent = d.text ?? '';
        else if (ev.event === 'text') { said += d.delta ?? ''; status.textContent = ''; draw(); }
        else if (ev.event === 'reset') { said = ''; draw(); }
        else if (ev.event === 'block' && d.type === 'table') msg.append(tableBlock(d.data ?? {}, go));
        else if (ev.event === 'error') { status.textContent = d.text ?? t('an.fail'); }
        else if (ev.event === 'done') status.textContent = '';
      }, { signal: ctrl.signal, headers: { 'X-Requested-With': CSRF } });
    } catch (e) {
      if (e.name !== 'AbortError') status.textContent = e.body?.message ?? t('an.fail');
    } finally {
      busy = false;
      send.disabled = false;
      ctrl = null;
    }
  }

  return () => { dead = true; ctrl?.abort(); };
}
