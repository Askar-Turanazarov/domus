// ai_activity (08 §3.2): turns, errors, reserve use, feedback, unanswered questions and the money of the AI for a period.
import { z } from 'zod';
import { defineTool } from './define.js';
import { aiActivityOf } from '../core/analytics.js';
import { day } from './common.js';

export default defineTool({
  name: 'ai_activity',
  title: { ru: 'Активность ИИ', uz: 'SI faolligi', en: 'AI activity' },
  description: 'The AI consultant for a period of Tashkent days (from/to inclusive, default today): turns, errors, fallbacks to the reserve model, '
    + 'tool calls, thumbs up/down, questions the knowledge base could not answer, the cost in USD and the calls by model.',
  input: z.strictObject({ from: day.optional(), to: day.optional() }),
  output: z.object({ from: z.string(), to: z.string() }).loose(),
  roles: ['head'],
  mutates: false,
  run: (args, ctx) => aiActivityOf(ctx.db, args, ctx.core)
});
