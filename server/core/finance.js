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
