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
