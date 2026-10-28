// funnel (08 §3.2): visitors → dialogs → holds → paid bookings → sales of a period, with the conversions (the dashboard's figures).
import { z } from 'zod';
import { defineTool } from './define.js';
import { funnel } from '../core/analytics.js';
import { day } from './common.js';

export default defineTool({
  name: 'funnel',
  title: { ru: 'Воронка продаж', uz: 'Sotuv voronkasi', en: 'Sales funnel' },
  description: 'The funnel for a period of Tashkent days (from/to inclusive, default today): visitors, dialogs, holds, paid bookings, sales, '
    + 'and the conversions between them as shares 0..1 (expiredShare: the share of paid bookings that burned).',
  input: z.strictObject({ from: day.optional(), to: day.optional() }),
  output: z.object({ from: z.string(), to: z.string() }).loose(),
  roles: ['head'],
  mutates: false,
  run: (args, ctx) => funnel(ctx.db, args, ctx.core)
});
