// list_payments (08 §3.2): payments for the head; the client as name + masked phone, the card as the mask.
import { z } from 'zod';
import { defineTool } from './define.js';
import { periodOf } from '../core/analytics.js';
import { day, clientsOf } from './common.js';

export default defineTool({
  name: 'list_payments',
  title: { ru: 'Список оплат', uz: 'To‘lovlar ro‘yxati', en: 'List payments' },
  description: 'Lists payments, newest first: code, booking, provider, amount in sum, status (pending, processing, succeeded, failed, '
    + 'cancelled, refund_due, refunded), the client\'s name and masked phone. from/to are Tashkent days, inclusive. Default 20, at most 100.',
  input: z.strictObject({
    status: z.enum(['pending', 'processing', 'succeeded', 'failed', 'cancelled', 'refund_due', 'refunded']).optional(),
    provider: z.enum(['card', 'click', 'stripe']).optional(),
    from: day.optional(),
    to: day.optional(),
    limit: z.number().int().min(1).max(100).optional()
  }),
  output: z.object({ total: z.number().int(), items: z.array(z.object({ code: z.string() }).loose()) }),
  roles: ['head'],
  mutates: false,
  async run({ status, provider, from, to, limit = 20 }, ctx) {
    const p = from || to ? periodOf({ from, to }, ctx.now) : { from: null, to: null };
    const rows = await ctx.db.query(`SELECT p.*, b.no AS booking_no FROM payments p LEFT JOIN bookings b ON b.id = p.booking_id
      WHERE ($1::text IS NULL OR p.status = $1) AND ($2::text IS NULL OR p.provider = $2)
        AND ($3::timestamptz IS NULL OR p.created_at >= $3) AND ($4::timestamptz IS NULL OR p.created_at < $4)
      ORDER BY p.created_at DESC, p.code LIMIT $5`, [status ?? null, provider ?? null, p.from, p.to, limit]);
    const who = await clientsOf(ctx, rows.map(r => r.client_id));
    return { total: rows.length, items: rows.map(r => ({ code: r.code, kind: r.kind, bookingNo: r.booking_no ?? null, provider: r.provider,
      amount: Number(r.amount), status: r.status, card: r.card_mask ?? null, createdAt: new Date(r.created_at).toISOString(),
      succeededAt: r.succeeded_at ? new Date(r.succeeded_at).toISOString() : null, client: who(r.client_id) })) };
  }
});
