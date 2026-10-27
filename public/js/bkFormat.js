// Pure helpers of the booking page and the payment emulators (11 §6, §10): sums, Tashkent time, the timer that
// follows the server's clock and the input masks. No DOM here, so node tests can run it.

const NBSP = ' ';
const TASHKENT_MS = 5 * 3600e3;                       // UTC+5 all year, no daylight saving
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = n => String(n).padStart(2, '0');

// 812000000 → "812 000 000" (non-breaking spaces).
export const groupNum = n => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);

// "28.10, 15:00" (ru, uz) / "Oct 28, 3:00 PM" (en); the time of Tashkent whatever the clock of the browser says.
export function tashkent(iso, lang = 'ru') {
  const ms = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms + TASHKENT_MS);
  const day = d.getUTCDate(), month = d.getUTCMonth(), h = d.getUTCHours(), m = d.getUTCMinutes();
  if (lang === 'en') return `${MONTHS_EN[month]} ${day}, ${h % 12 || 12}:${two(m)} ${h < 12 ? 'AM' : 'PM'}`;
  return `${two(day)}.${two(month + 1)}, ${two(h)}:${two(m)}`;
}

// "15:00" in Tashkent (the end of a hold on the card).
export function hhmm(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms + TASHKENT_MS);
  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

// The server's clock minus ours at the moment of the answer: the timer adds it to our clock (11 §6.1).
export const skewOf = (serverNowIso, localNowMs) => {
  const server = Date.parse(serverNowIso);
  return Number.isFinite(server) ? server - localNowMs : 0;
};

// Milliseconds to the deadline by the server's clock; never below zero.
export const remainingMs = (expiresIso, skew, localNowMs) => Math.max(0, Date.parse(expiresIso) - (localNowMs + skew));

// 768000 → "12:48"; an hour or more → "1:02:03".
export function clock(ms) {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  return h ? `${h}:${two(m)}:${two(sec)}` : `${two(m)}:${two(sec)}`;
}

// ---- input masks (the digits only; the number never goes anywhere but the emulator's request) ----

// "98600000" → "9860 0000"; 16 digits at most.
export const cardNumber = v => String(v).replace(/\D/g, '').slice(0, 16).replace(/(\d{4})(?=\d)/g, '$1 ');

// "1228" → "12/28".
export function expiry(v) {
  const d = String(v).replace(/\D/g, '').slice(0, 4);
  return d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
}

// +998 XX XXX XX XX from whatever was typed (applied when the field is left, not while typing); the server normalizes again.
export function phone(v) {
  let d = String(v).replace(/\D/g, '');
  if (d.startsWith('998')) d = d.slice(3);
  d = d.slice(0, 9);
  const parts = [d.slice(0, 2), d.slice(2, 5), d.slice(5, 7), d.slice(7, 9)].filter(Boolean);
  return parts.length ? `+998 ${parts.join(' ')}` : '';
}

// The brand by the first digits, as the server does (05 §4.2).
export const brandOf = digits => (digits.startsWith('9860') ? 'HUMO' : /^(8600|5614)/.test(digits) ? 'UZCARD' : null);

// "I accept the [public offer]" → [{ text: 'I accept the ' }, { text: 'public offer', link: true }]: the sentence of a
// translation keeps its own word order, the brackets only mark the words that are the link.
export function linkParts(text) {
  const out = [];
  let rest = String(text);
  for (let m = /\[([^\]]+)\]/.exec(rest); m; m = /\[([^\]]+)\]/.exec(rest)) {
    if (m.index) out.push({ text: rest.slice(0, m.index) });
    out.push({ text: m[1], link: true });
    rest = rest.slice(m.index + m[0].length);
  }
  if (rest) out.push({ text: rest });
  return out;
}

// The edition of the offer ("2026-10-27") as a date: 27.10.2026 (ru, uz) / Oct 27, 2026 (en); anything else as it is.
export function versionDate(v, lang = 'ru') {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
  if (!m) return String(v ?? '');
  return lang === 'en' ? `${MONTHS_EN[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : `${m[3]}.${m[2]}.${m[1]}`;
}
