// Dialogs «with a manager» (12 §5.4, FR-AGT-10): the dialogs in mode 'human', the longest waiting for an answer on top. A row opens
// the client card with this dialog, where the manager replies or returns the AI. Polled every 5 s; everything as text.
import { api, ApiError } from '../api.js';
import { el, toast, dateTime } from '../ui.js';
import { t, addTexts } from '../i18n.js';
import { label } from './common.js';

addTexts({
  ru: { 'inb.title': 'Диалоги с менеджером', 'inb.empty': 'Никто не ждёт менеджера', 'inb.waiting': 'ждёт ответа с {when}',
    'inb.answered': 'отвечено {when}', 'inb.noName': 'Без имени', 'inb.assignee': 'Ведёт: {name}', 'inb.free': 'никто не взял',
    'inb.more': 'Показать ещё' },
  en: { 'inb.title': 'Dialogs with a manager', 'inb.empty': 'Nobody is waiting for a manager', 'inb.waiting': 'waiting since {when}',
    'inb.answered': 'answered {when}', 'inb.noName': 'No name', 'inb.assignee': 'Handled by {name}', 'inb.free': 'not taken',
    'inb.more': 'Show more' },
  uz: { 'inb.title': 'Menejer bilan suhbatlar', 'inb.empty': 'Hech kim menejer kutmayapti', 'inb.waiting': '{when} dan beri javob kutmoqda',
    'inb.answered': '{when} javob berildi', 'inb.noName': 'Ismsiz', 'inb.assignee': 'Olib boradi: {name}', 'inb.free': 'hech kim olmagan',
    'inb.more': 'Yana ko‘rsatish' }
});

const POLL_MS = 5000;

export function mount(root) {
  let items = [], next = null, loaded = false, dead = false, token = 0;
  const list = el('div', { class: 'adm2-inbox' });
  const more = el('div', { class: 'adm2-more' });
  root.replaceChildren(el('h1', { class: 'adm2-h1' }, t('inb.title')), list, more);

  const open = d => { location.hash = `#/clients/${d.clientId}/${d.id}`; };
  function row(d) {
    return el('li', { class: 'adm2-inbox-row' + (d.waiting ? ' waiting' : ''), tabindex: 0, dataset: { id: d.id },
      on: { click: () => open(d), keydown: e => { if (e.key === 'Enter') open(d); } } },
    el('div', {}, el('b', {}, d.name || t('inb.noName')), ' ', el('small', { class: 'adm2-muted' }, `${d.phone || ''} · ${label('ch.', d.channel)}`)),
    d.lastText && el('div', { class: 'adm2-msg' }, d.lastText),
    el('small', { class: d.waiting ? 'adm2-waiting' : 'adm2-muted' },
      d.waiting ? '● ' + t('inb.waiting', { when: dateTime(d.waitingSince) }) : t('inb.answered', { when: dateTime(d.lastStaffAt) }),
      ' · ', d.assignee ? t('inb.assignee', { name: d.assignee.name }) : t('inb.free')));
  }

  function draw() {
    list.replaceChildren(items.length ? el('ul', { class: 'adm2-list' }, items.map(row))
      : el('p', { class: 'adm2-empty' }, loaded ? t('inb.empty') : t('app.loading')));
    more.replaceChildren(...(next ? [el('button', { type: 'button', class: 'btn', on: { click: () => load(true) } }, t('inb.more'))] : []));
  }

  async function load(append = false) {
    const mine = ++token;
    const qs = new URLSearchParams({ mode: 'human' });
    if (append && next) qs.set('cursor', next);
    else qs.set('limit', String(Math.min(100, Math.max(50, items.length))));
    try {
      const r = await api(`/api/admin/conversations?${qs}`);
      if (dead || mine !== token) return;
      items = append ? items.concat(r.items) : r.items;
      next = r.next; loaded = true;
      draw();
    } catch (ex) {
      if (dead || mine !== token || (ex instanceof ApiError && ex.status === 401)) return;
      toast(t('app.fail'), true);
    }
  }

  draw(); load();
  const timer = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
  return () => { dead = true; clearInterval(timer); };
}
