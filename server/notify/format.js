// Text pieces of Telegram messages (04 §4, 00 §2.2): sums with spaces, Tashkent time, HTML escaping. Pure.
// Not shared with public/js/bkFormat.js on purpose: the function bundle on Vercel has no public/js (vercel.json excludeFiles).

const NBSP = ' ';
const TASHKENT_MS = 5 * 3600e3;                       // UTC+5 all year, no daylight saving
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = n => String(n).padStart(2, '0');

// 10000000 → "10 000 000" (non-breaking spaces: the number is never split between lines).
export const money = n => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);

// 82.4 → "82,4" (ru, uz) / "82.4" (en)
export const areaText = (n, lang = 'ru') => {
  const s = String(Number(n) || 0);
  return lang === 'en' ? s : s.replace('.', ',');
};

// "29.10, 18:00" (ru, uz) / "Oct 29, 6:00 PM" (en); Tashkent time whatever the server's zone is.
export function tashkent(iso, lang = 'ru') {
  const ms = iso instanceof Date ? iso.getTime() : Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms + TASHKENT_MS);
  const day = d.getUTCDate(), month = d.getUTCMonth(), h = d.getUTCHours(), m = d.getUTCMinutes();
  if (lang === 'en') return `${MONTHS_EN[month]} ${day}, ${h % 12 || 12}:${two(m)} ${h < 12 ? 'AM' : 'PM'}`;
  return `${two(day)}.${two(month + 1)}, ${two(h)}:${two(m)}`;
}

// Telegram HTML parse mode: only &, < and > are special in the text; quotes in attribute values too.
export const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const escAttr = s => esc(s).replace(/"/g, '&quot;');
