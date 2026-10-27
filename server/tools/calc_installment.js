// calc_installment (08 §3.1, 03 §11.1): the developer's installment — down payment (the paid deposit counted), terms, markup,
// monthly payment, the schedule as the first 3 payments and the last one.
import { z } from 'zod';
import { defineTool } from './define.js';
import { installment } from '../core/finance.js';
import { aptNo, sum, oneOf, priceOf, settings } from './common.js';

// The deposit already paid on this apartment by this client (a booked booking, merged cards too) | null.
export async function paidDeposit(ctx, no) {
  if (no == null || ctx.actor?.role !== 'client' || !ctx.actor.id) return null;
  const b = await ctx.db.one(`SELECT deposit_amount FROM bookings WHERE apartment_no = $1 AND status = 'booked' AND expires_at > $3
      AND client_id IN (SELECT id FROM clients WHERE id = $2 OR merged_into = $2) LIMIT 1`, [no, ctx.actor.id, ctx.now()]);
  return b ? Number(b.deposit_amount) : null;
}

export const plan = r => ({
  months: r.months, markupPct: r.markupPct, down: r.down, rest: r.rest, restWithMarkup: r.restWithMarkup, monthly: r.monthly,
  last: r.last, markup: r.markup, total: r.total, toPayNow: r.toPayNow,
  schedule: [1, 2, 3].filter(m => m < r.months).map(month => ({ month, amount: r.monthly })).concat({ month: r.months, amount: r.last })
});

export default defineTool({
  name: 'calc_installment',
  title: { ru: 'Рассрочка от застройщика', uz: 'Quruvchidan muddatli to‘lov', en: 'Developer installment plan' },
  description: 'Developer installment plan, whole UZS: down payment (at least the minimum %, the paid booking deposit is counted), '
    + 'markup for the term, monthly payment, last payment, total. Give no (apartment number) or price. Without months — every term '
    + 'from the settings. Schedule: months are numbered from 1 to n, without dates.',
  input: z.strictObject({
    no: aptNo.optional().describe('Apartment number instead of the price'),
    price: sum.optional().describe('Apartment price, UZS'),
    downPct: z.number().min(0).max(99).optional().describe('Down payment, % of the price; default and minimum from the settings'),
    months: z.number().int().positive().optional().describe('Term in months, one of the settings terms; omit for all terms')
  }),
  output: z.object({ price: z.number().int(), minDownPct: z.number(), plans: z.array(z.object({ months: z.number().int() }).loose()) }).loose(),
  roles: ['client', 'head'],
  mutates: false,
  async run(a, ctx) {
    oneOf(a, ['no', 'price']);
    const { price, no } = await priceOf(a, ctx);
    const s = (await settings(ctx)).installment;
    const deposit = await paidDeposit(ctx, no);
    const terms = a.months == null ? s.terms.map(t => t.months) : [a.months];
    const rows = terms.map(months => installment({ price, downPct: a.downPct, months, deposit }, s));
    return { ...(no ? { no } : {}), price, downPct: rows[0].downPct, minDownPct: s.minDownPct, depositPaid: deposit, plans: rows.map(plan) };
  }
});
