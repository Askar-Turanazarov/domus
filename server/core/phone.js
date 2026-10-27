// Phone numbers (02 §3.4): one normal form, E.164 (+998901234567). Pure; the browser has the same rules.

// '90 123-45-67', '998901234567', '+44 20 7946 0958' → '+998901234567' / '+442079460958'; anything else → null.
export function normalizePhone(s) {
  const d = String(s ?? '').replace(/[\s\-()]/g, '');
  if (/^\d{9}$/.test(d)) return '+998' + d;
  if (/^998\d{9}$/.test(d)) return '+' + d;
  if (/^\+\d{8,15}$/.test(d)) return d;
  return null;
}

// For the staff group and the logs: '+998 90 *** ** 67' — country and operator code plus the last two digits.
export function maskPhone(s) {
  const p = normalizePhone(s);
  if (!p) return '***';
  if (p.startsWith('+998')) return `+998 ${p.slice(4, 6)} *** ** ${p.slice(-2)}`;
  return `${p.slice(0, 3)} *** ${p.slice(-2)}`;
}
