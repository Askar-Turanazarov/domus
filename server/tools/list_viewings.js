// list_viewings (08 §3.2): viewing appointments for the head; the time is Tashkent time, the phone is masked.
import { z } from 'zod';
import { defineTool } from './define.js';
import { periodOf } from '../core/analytics.js';
import { listViewings, tashkentText } from '../core/viewingsDb.js';
import { maskPhone } from '../core/phone.js';
import { day } from './common.js';

export default defineTool({
  name: 'list_viewings',
  title: { ru: 'Записи на показ', uz: 'Ko‘rish yozuvlari', en: 'List viewings' },
  description: 'Lists viewing appointments by time (earliest first): apartment, time in Tashkent, the client\'s name and masked phone, '
    + 'status (scheduled, done, no_show, cancelled). from/to are Tashkent days, inclusive. Default 50, at most 100.',
  input: z.strictObject({
    status: z.enum(['scheduled', 'done', 'no_show', 'cancelled']).optional(),
    from: day.optional(),
    to: day.optional(),
    limit: z.number().int().min(1).max(100).optional()
  }),
  output: z.object({ total: z.number().int(), items: z.array(z.object({ apartmentNo: z.number().int() }).loose()) }),
  roles: ['head'],
  mutates: false,
  async run({ status, from, to, limit = 50 }, ctx) {
    const p = from || to ? periodOf({ from, to }, ctx.now) : { from: null, to: null };
    const rows = await listViewings(ctx.db, { from: p.from, to: p.to, status: status ?? null, limit });
    return { total: rows.length, items: rows.map(v => ({ apartmentNo: v.apartment_no, at: tashkentText(new Date(v.at)), status: v.status,
      channel: v.channel, client: { name: v.name ?? null, phone: maskPhone(v.phone) } })) };
  }
});
