// Installments, mortgage, comparison (03 §11). Pure: the settings come in as arguments.
import { DomainError } from './errors.js';

// Annuity mortgage: equal monthly payments at the monthly rate i = rate / 12 / 100. Pure.
// Either price + downPct (the down payment in % of the price) or the loan itself; years — the term, rate — % per year (0 = no interest).
// monthly = loan · i / (1 − (1 + i)^−n); total and overpay come from the exact payment, every result is rounded to whole sum.
export function annuity({ price, downPct = 0, loan, years, rate }) {
  if (loan == null) loan = price - Math.round(price * downPct / 100);
  else price = loan;
  const months = years * 12;
  const i = rate / 12 / 100;
  const exact = i ? loan * i / (1 - (1 + i) ** -months) : loan / months;
  const total = Math.round(exact * months);
  return { price, down: price - loan, loan, months, monthly: Math.round(exact), total, overpay: total - loan };
}

// 03 §11.2: the Domus formula unchanged.
export const mortgage = annuity;

// round(a × b / c) and floor(a / b) on whole sums, exact (BigInt: price × 110 overflows nothing, but stays honest, BR-01).
const roundDiv = (num, den) => Number((2n * num + den) / (2n * den));
const floorDiv = (num, den) => Number(num / den);

// 03 §11.1, one term. installment — settings.installment { minDownPct, terms: [{months, markupPct}] };
// deposit — the paid booking's deposit_amount (null: nothing paid yet).
export function installment({ price, downPct, months, deposit = null }, installment) {
  if (!Number.isInteger(price) || price <= 0) throw new DomainError('invalid_input', { fields: ['price'] });
  const min = installment.minDownPct;
  const pct = downPct ?? min;
  if (typeof pct !== 'number' || pct < min || pct >= 100) throw new DomainError('down_payment_too_low', { min });
  const term = installment.terms.find(t => t.months === months);
  if (!term) throw new DomainError('term_not_available', { terms: installment.terms.map(t => t.months) });
  // downPct may be fractional (32.5 %): scaled by 100 to stay in integers
  const p100 = BigInt(Math.round(pct * 100));
  const D = roundDiv(BigInt(price) * p100, 10000n);
  const R = price - D;
  const T = roundDiv(BigInt(R) * BigInt(100 + term.markupPct), 100n);
  const monthly = floorDiv(BigInt(T), BigInt(months));
  const last = T - monthly * (months - 1);
  return {
    price, downPct: pct, down: D, rest: R, months, markupPct: term.markupPct, restWithMarkup: T, monthly, last,
    markup: T - R, total: D + T, deposit, toPayNow: deposit ? D - deposit : D,
    schedule: [{ from: 1, to: months - 1, amount: monthly }, { from: months, to: months, amount: last }]
  };
}

// Every term of the settings (calc_installment without months).
export const installments = ({ price, downPct, deposit = null }, s) =>
  s.terms.map(t => installment({ price, downPct, months: t.months, deposit }, s));

// 03 §11.3 (S): installment rows and, with a rate, a mortgage row; overpay = markup / bank interest.
export function compare({ price, downPct, mortgage: m = null, deposit = null }, s) {
  const rows = installments({ price, downPct, deposit }, s).map(r => ({
    kind: 'installment', months: r.months, down: r.down, monthly: r.monthly, total: r.total, overpay: r.markup }));
  if (m?.years && m.rate != null) {
    const a = annuity({ price, downPct: downPct ?? s.minDownPct, years: m.years, rate: m.rate });
    rows.push({ kind: 'mortgage', months: a.months, years: m.years, rate: m.rate, down: a.down, monthly: a.monthly,
      total: a.down + a.total, overpay: a.overpay });
  }
  return { price, rows, needRate: !(m?.years && m.rate != null) };
}
