// calc_mortgage (08 §3.1): the Domus annuity unchanged — loan, or price with a down payment, or an apartment number.
import { z } from 'zod';
import { defineTool } from './define.js';
import { DomainError } from '../core/errors.js';
import { mortgage } from '../core/finance.js';
import { aptNo, sum, pct, oneOf, priceOf } from './common.js';

export const years = z.number().int().min(1).max(30);
export const rate = z.number().min(0).max(60);

export default defineTool({
  name: 'calc_mortgage',
  title: { ru: 'Ипотека (аннуитет)', uz: 'Ipoteka (annuitet)', en: 'Mortgage (annuity)' },
  description: 'Annuity mortgage with the monthly rate = annual rate / 12: monthly payment, total paid and overpayment, whole UZS. '
    + 'Give exactly one of: loan, price (with downPct), or no (the apartment price is taken). The rate and the term come from the user — '
    + 'never assume a "typical" rate; ask if it is missing.',
  input: z.strictObject({
    no: aptNo.optional().describe('Apartment number instead of the price'),
    price: sum.optional().describe('Apartment price, UZS (loan = price − down payment)'),
    loan: sum.optional().describe('Loan amount, UZS'),
    downPct: pct.optional().describe('Down payment, % of the price (default 0)'),
    years: years.describe('Term, years'),
    rate: rate.describe('Interest rate, % per year')
  }),
  output: z.object({ monthly: z.number().int(), total: z.number().int(), overpay: z.number().int() }).loose(),
  roles: ['client', 'head'],
  mutates: false,
  async run(a, ctx) {
    oneOf(a, ['no', 'price', 'loan']);
    if (a.loan != null) {
      if (a.downPct) throw new DomainError('invalid_input', { fields: ['downPct'] });
      return mortgage({ loan: a.loan, years: a.years, rate: a.rate });
    }
    const { price, no } = await priceOf(a, ctx);
    return { ...mortgage({ price, downPct: a.downPct ?? 0, years: a.years, rate: a.rate }), ...(no ? { no } : {}) };
  }
});
