// compare_finance (08 §3.1, 03 §11.3, S): installment terms side by side with a mortgage — only when the user gave the bank's rate.
import { z } from 'zod';
import { defineTool } from './define.js';
import { compare } from '../core/finance.js';
import { aptNo, sum, oneOf, priceOf, settings } from './common.js';
import { years, rate } from './calc_mortgage.js';
import { paidDeposit } from './calc_installment.js';

export default defineTool({
  name: 'compare_finance',
  title: { ru: 'Рассрочка или ипотека', uz: 'Muddatli to‘lov yoki ipoteka', en: 'Installment vs mortgage' },
  description: 'Compares the developer installment terms and, if mortgage {years, rate} is given, a mortgage: down payment, '
    + 'monthly payment, term, total paid, overpayment above the price (installment markup / bank interest). Give no or price. '
    + 'Without a rate there are installment rows only and needRate = true: ask the user for the bank rate, never assume one.',
  input: z.strictObject({
    no: aptNo.optional().describe('Apartment number instead of the price'),
    price: sum.optional().describe('Apartment price, UZS'),
    downPct: z.number().min(0).max(99).optional().describe('Down payment, % of the price; default and minimum from the settings'),
    mortgage: z.strictObject({ years: years.describe('Term, years'), rate: rate.describe('Bank rate, % per year') }).optional()
      .describe('The bank mortgage to compare with, as named by the user')
  }),
  output: z.object({ price: z.number().int(), rows: z.array(z.object({ kind: z.string() }).loose()), needRate: z.boolean() }).loose(),
  roles: ['client', 'head'],
  mutates: false,
  async run(a, ctx) {
    oneOf(a, ['no', 'price']);
    const { price, no } = await priceOf(a, ctx);
    const s = (await settings(ctx)).installment;
    const deposit = await paidDeposit(ctx, no);
    return { ...(no ? { no } : {}), ...compare({ price, downPct: a.downPct, mortgage: a.mortgage ?? null, deposit }, s) };
  }
});
