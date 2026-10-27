// The figures check before sending (07 §15.4): every sum (≥ 1 000 000, «980 млн», «1,02 млрд») and every apartment number
// in an agent's text must be among the numbers of this turn's tool calls (results and arguments) or of the client's own
// message. Allowed rounding: half of the last written digit, at least 1000. Pure.

const UNITS = [
  [/^(млрд|mlrd|milliard|billion|bn)/i, 1e9],
  [/^(млн|mln|million|m\b)/i, 1e6],
  [/^(тыс|ming|thousand|k\b)/i, 1e3]
];
// 1 024 500 000 · 1.024.500.000 · 1,024,500,000 · 980 млн · 1,02 млрд · 1.5 billion
const SUM = /(?<![\d.,])(\d{1,3}(?:[  .,]\d{3})+|\d+(?:[.,]\d+)?)(\s?)(млрд|mlrd|milliard|billion|bn|млн|mln|million|тыс|ming|thousand)?/giu;
// №41 · № 41 · 41-xonadon · Apt. 41 · apartment 41 · квартира 41
const APT = /(?:№\s?(\d{1,4})|(\d{1,4})-xonadon|\b(?:apt\.?|apartment)\s?(\d{1,4})|квартир[аеыу]?\s(\d{1,4}))/giu;

// → [{ text, value, tol, kind: 'sum' | 'apt' }]
export function figuresIn(text) {
  const out = [];
  const s = String(text ?? '');
  for (const m of s.matchAll(SUM)) {
    const [whole, num, , unit] = m;
    let value, tol;
    if (unit) {
      const k = UNITS.find(([re]) => re.test(unit))[1];
      const frac = num.replace(',', '.');
      const dec = frac.includes('.') ? frac.split('.')[1].length : 0;
      value = Number(frac) * k;
      tol = Math.max(1000, (k / 10 ** dec) / 2);
    } else {
      const digits = num.replace(/[  .,]/g, '');
      if (!/^\d+$/.test(digits) || Number(digits) < 1_000_000) continue;
      if (!/[  .,]/.test(num) && digits.length < 7) continue;
      value = Number(digits);
      tol = 1000;
    }
    if (value < 1_000_000) continue;
    out.push({ text: whole.trim(), value, tol, kind: 'sum' });
  }
  for (const m of s.matchAll(APT)) {
    const no = Number(m[1] ?? m[2] ?? m[3] ?? m[4]);
    out.push({ text: m[0], value: no, tol: 0, kind: 'apt' });
  }
  return out;
}

// Every number inside the tool calls and results (deep), plus the figures the client wrote.
export function knownNumbers({ calls = [], message = '' } = {}) {
  const set = [];
  const walk = v => {
    if (typeof v === 'number' && Number.isFinite(v)) set.push(v);
    else if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v)) set.push(Number(v));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  for (const c of calls) { walk(c.args); walk(c.result); }
  for (const f of figuresIn(message)) set.push(f.value);
  return set;
}

// → the figures of the text that are not known: [] — grounded.
export function ungrounded(text, known) {
  return figuresIn(text).filter(f => !known.some(v => Math.abs(v - f.value) <= f.tol));
}

// The second miss: each unknown figure is replaced by the phrase (07 §15.4 step 2).
export function scrub(text, missing, phrase) {
  let s = String(text ?? '');
  for (const f of missing) s = s.replace(f.text, phrase);
  return s;
}
