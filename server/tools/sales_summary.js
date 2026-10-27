// sales_summary (08 §3.2): money and counts of the period, Tashkent days (default today).
import { z } from 'zod';
import { defineTool } from './define.js';
import { summary } from '../core/analytics.js';
import { day } from './common.js';

export default defineTool({
  name: 'sales_summary',
  title: { ru: 'Сводка продаж', uz: 'Sotuvlar xulosasi', en: 'Sales summary' },
  description: 'Deposits received (refunds excluded), holds started, paid bookings, sales and conversion for a period of Tashkent days '
    + '(from/to inclusive, default today). Amounts in sum.',
  input: z.strictObject({ from: day.optional(), to: day.optional() }),
  output: z.object({ from: z.string(), to: z.string() }).loose(),
  roles: ['head'],
  mutates: false,
  run: (args, ctx) => summary(ctx.db, args, ctx.core)
});
