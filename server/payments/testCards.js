// Test cards of the emulators (05 §4.2, D-18): only these numbers are accepted, so a real card never reaches us
// (NFR-PRIV-03). All pass the Luhn check. The page shows the table under «Тестовые карты».
export const TEST_CARDS = Object.freeze([
  { number: '9860000000090001', brand: 'HUMO', scenario: 'success' },
  { number: '8600000000060001', brand: 'UZCARD', scenario: 'success' },
  { number: '5614000000060001', brand: 'UZCARD', scenario: 'success' },
  { number: '9860000000000000', brand: 'HUMO', scenario: 'bank_declined' },
  { number: '8600000000070000', brand: 'UZCARD', scenario: 'bank_declined' },
  { number: '8600000000050002', brand: 'UZCARD', scenario: 'insufficient_funds' },
  { number: '9860000000080002', brand: 'HUMO', scenario: 'insufficient_funds' }
].map(Object.freeze));

export function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

// The brand by the first digits: 9860 → HUMO; 8600, 5614 → UzCard. → 'HUMO' | 'UZCARD' | null
export const brandOf = number => (number.startsWith('9860') ? 'HUMO' : /^(8600|5614)/.test(number) ? 'UZCARD' : null);

// First 4 and last 4: '9860 •••• 0001'.
export const maskOf = number => `${number.slice(0, 4)} •••• ${number.slice(-4)}`;

// Today in Tashkent (UTC+5, no daylight saving) → { year, month }.
function tashkentMonth(at) {
  const d = new Date(at.getTime() + 5 * 3600e3);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

// The form checks of 05 §4.3 steps 3–5. → { error: 'card_invalid' | 'card_expired' | 'card_not_supported' } | { card }.
// The number is never returned, stored or logged — only brand, mask and scenario.
export function checkCard({ number, expiry } = {}, at) {
  const digits = String(number ?? '').replace(/[\s-]/g, '');
  if (!/^\d{16}$/.test(digits) || !luhn(digits)) return { error: 'card_invalid' };
  const m = /^(\d{2})\/(\d{2})$/.exec(String(expiry ?? '').trim());
  const month = m && Number(m[1]);
  if (!m || month < 1 || month > 12) return { error: 'card_expired' };
  const now = tashkentMonth(at);
  const year = 2000 + Number(m[2]);
  if (year < now.year || (year === now.year && month < now.month)) return { error: 'card_expired' };
  const card = TEST_CARDS.find(c => c.number === digits);
  if (!card) return { error: 'card_not_supported' };
  return { card: { brand: card.brand, mask: maskOf(digits), scenario: card.scenario } };
}
