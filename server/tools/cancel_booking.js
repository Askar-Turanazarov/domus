// cancel_booking (08 §3.2, 03 §7): the head cancels a hold or a booking on behalf of the developer — a paid deposit is refunded
// in full by the core (BR-12). After the confirmation only; the money moves are the core's, the tool only asks.
import { z } from 'zod';
import { defineTool } from './define.js';
import { DomainError } from '../core/errors.js';
import { cancel } from '../core/bookings.js';
import { bookingByNo } from './common.js';

export default defineTool({
  name: 'cancel_booking',
  title: { ru: 'Отменить бронь', uz: 'Bronni bekor qilish', en: 'Cancel a booking' },
  description: 'Cancels a live hold or booking on behalf of the developer; the client is told, and a paid deposit is refunded in full '
    + 'automatically. Requires the head\'s explicit confirmation: the first call returns a preview that says whether a refund follows.',
  input: z.strictObject({
    bookingNo: z.number().int().positive().describe('Booking number, e.g. 1042'),
    reason: z.string().trim().min(3).max(300).describe('The reason, shown to the client')
  }),
  output: z.object({ bookingNo: z.number().int(), apartmentNo: z.number().int(), refund: z.boolean() }),
  roles: ['head'],
  sources: ['mcp'],
  mutates: true,
  async preview({ bookingNo, reason }, ctx) {
    const b = await bookingByNo(ctx, bookingNo);
    if (!['held', 'booked'].includes(b.status)) throw new DomainError('booking_closed');
    return { bookingNo, apartmentNo: b.apartment_no, status: b.status, reason, deposit: Number(b.deposit_amount), refund: b.status === 'booked' };
  },
  async run({ bookingNo, reason }, ctx) {
    const b = await bookingByNo(ctx, bookingNo);
    await cancel(ctx.db, { bookingId: b.id, initiator: 'developer', reason }, ctx.actor, ctx.core);
    return { bookingNo, apartmentNo: b.apartment_no, refund: b.status === 'booked' };
  }
});
