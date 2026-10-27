// Small helpers of the admin: DOM builder (data goes in as text only), toast, number / date / time-left formats.
import { t, getLang } from './i18n.js';

export function el(tag, props = {}, ...kids) {
  const { class: cls, dataset, on, ...rest } = props;
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(rest)) (k.includes('-') ? e.setAttribute(k, v) : (e[k] = v));   // aria-*, data-* as attributes
  if (cls) e.className = cls;
  if (dataset) Object.assign(e.dataset, dataset);
  if (on) for (const [k, fn] of Object.entries(on)) e.addEventListener(k, fn);
  e.append(...kids.flat().filter(k => k != null && k !== false));
  return e;
}

let timer;
export function toast(text, isError = false) {
  const box = document.getElementById('toast');
  box.textContent = text;
  box.className = 'toast' + (isError ? ' error' : '');
  box.hidden = false;
  clearTimeout(timer);
  timer = setTimeout(() => { box.hidden = true; }, isError ? 5000 : 3000);
}

const LOCALE = { ru: 'ru-RU', uz: 'uz-UZ', en: 'en-GB' };
const TZ = 'Asia/Tashkent';
export const money = v => `${String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ${t('unit.sum')}`;
export const dateTime = iso => (iso ? new Intl.DateTimeFormat(LOCALE[getLang()] || 'en-GB', { dateStyle: 'short', timeStyle: 'short', timeZone: TZ }).format(new Date(iso)) : '—');

// Time left: «14 min», «5 h», «2 d 5 h»; null when the moment has passed.
export function left(ms) {
  if (ms <= 0) return null;
  const min = Math.ceil(ms / 60e3);
  if (min < 60) return t('left.min', { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t('left.h', { n: h });
  return t('left.dh', { d: Math.floor(h / 24), h: h % 24 });
}

// A dialog over the page (12 §4): a lead line, fields, an error line. run(values) is the action; when it throws, the message
// stays in the dialog and the form stays open. fields — [{ name, label, kind: 'text' | 'area' | 'radio' | 'datetime', options, value,
// required, maxLength, when(values) }]. → a promise of run's result (true if it returns nothing), or null when closed without it.
export function askForm({ title, lead, hint, fields = [], submit, danger = false, run }) {
  return new Promise(resolve => {
    const values = Object.fromEntries(fields.map(f => [f.name, f.value ?? '']));
    const err = el('p', { class: 'adm2-err', role: 'alert' });
    const rows = [];
    const sync = () => rows.forEach(({ f, row }) => { row.hidden = f.when ? !f.when(values) : false; });
    const control = f => {
      const set = v => { values[f.name] = v; sync(); f.onChange?.(v, values); };
      if (f.kind === 'radio') {
        return el('div', { class: 'adm2-radios', role: 'radiogroup' }, f.options.map(o => el('label', { class: 'adm2-radio' },
          el('input', { type: 'radio', name: f.name, value: o.value, checked: o.value === f.value, on: { change: () => set(o.value), click: () => set(o.value) } }), ' ', o.label)));
      }
      const tag = f.kind === 'area' ? 'textarea' : 'input';
      return el(tag, { name: f.name, ...(tag === 'input' ? { type: f.kind === 'datetime' ? 'datetime-local' : 'text' } : { rows: 3 }),
        maxLength: f.maxLength ?? 300, value: f.value ?? '', on: { input: e => { values[f.name] = e.target.value; } } });
    };
    for (const f of fields) rows.push({ f, row: el('label', { class: 'adm2-field' }, el('span', {}, f.label), control(f)) });
    const button = el('button', { type: 'submit', class: 'btn ' + (danger ? 'danger' : 'primary') }, submit);
    const close = result => { document.removeEventListener('keydown', onKey); overlay.remove(); resolve(result); };
    const onKey = e => { if (e.key === 'Escape') close(null); };
    const form = el('form', { class: 'adm2-modal-box', on: { submit: async e => {
      e.preventDefault();
      const miss = fields.find(f => f.required && (!f.when || f.when(values)) && !String(values[f.name] ?? '').trim());
      if (miss) { err.textContent = t('form.required', { field: miss.label }); return; }
      button.disabled = true; err.textContent = '';
      try {
        const r = await run(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])));
        close(r ?? true);
      } catch (ex) {
        err.textContent = ex.message || t('app.fail');
        button.disabled = false;
      }
    } } },
    el('h2', {}, title), lead && el('p', {}, lead), hint && el('p', { class: 'adm2-muted' }, hint),
    rows.map(r => r.row), err,
    el('div', { class: 'adm2-modal-actions' }, el('button', { type: 'button', class: 'btn ghost', on: { click: () => close(null) } }, t('form.cancel')), button));
    const overlay = el('div', { class: 'adm2-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, on: { mousedown: e => { if (e.target === overlay) close(null); } } }, form);
    sync();
    document.addEventListener('keydown', onKey);
    document.body.append(overlay);
    form.querySelector('input:not([type=radio]), textarea')?.focus?.();
  });
}

// «14:05:30» in the building's time zone (the demo shift tells the exact second a deadline will pass).
export const clock = ms => new Intl.DateTimeFormat(LOCALE[getLang()] || 'en-GB', { timeStyle: 'medium', timeZone: TZ }).format(new Date(ms));
