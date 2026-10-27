// list_bookings (08 §3.2): the head's view — bookings with filters, «burning in the next N hours» among them.
import { z } from 'zod';
import { defineTool } from './define.js';
import { listBookings } from '../core/bookings.js';
import { periodOf } from '../core/analytics.js';
import { day, clientsOf } from './common.js';

const STATUSES = ['held', 'booked', 'hold_expired', 'released', 'expired', 'cancelled', 'converted'];

export default defineTool({
  name: 'list_bookings',
  title: { ru: 'Список броней', uz: 'Bronlar ro‘yxati', en: 'List bookings' },
  description: 'Lists bookings and holds, newest first, with the client\'s name and masked phone. Filters: status, expiringWithinHours '
    + '(live bookings whose deadline comes within N hours: "which bookings burn tomorrow" is 24 or 48), from/to (the day the hold started, '
    + 'Tashkent, inclusive). Default 20, at most 100.',
  input: z.strictObject({
    status: z.enum(STATUSES).optional(),
    expiringWithinHours: z.number().int().min(1).max(720).optional(),
    from: day.optional(),
    to: day.optional(),
    limit: z.number().int().min(1).max(100).optional()
  }),
  output: z.object({ total: z.number().int(), items: z.array(z.object({ bookingNo: z.number().int() }).loose()) }),
  roles: ['head'],
  mutates: false,
  async run({ status, expiringWithinHours, from, to, limit = 20 }, ctx) {
    const p = from || to ? periodOf({ from, to }, ctx.now) : { from: null, to: null };
    const rows = await listBookings(ctx.db, { status, expiringWithinHours, from: p.from, to: p.to, limit: status ? 200 : limit }, ctx.core);
    const items = rows.slice(0, limit);
    const who = await clientsOf(ctx, items.map(b => b.client_id));
    return { total: items.length, items: items.map(b => ({ bookingNo: b.no, apartmentNo: b.apartment_no, status: b.status,
      heldAt: new Date(b.held_at).toISOString(), until: new Date(b.expires_at).toISOString(), paid: Boolean(b.booked_at),
      deposit: Number(b.deposit_amount), price: Number(b.price_at_booking), extended: b.extended_count, client: who(b.client_id) })) };
  }
});
