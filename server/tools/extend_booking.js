// extend_booking (08 §3.2, 03 §6): the head extends a live paid booking — after the confirmation (the second call with confirmToken).
// The rules (not shorter, within extend_max_hours, the client and the group are told) are the core's.
import { z } from 'zod';
import { defineTool } from './define.js';
import { DomainError } from '../core/errors.js';
import { extend, settingsOf } from '../core/bookings.js';
import { bookingByNo } from './common.js';

const REASON = 'Extended by the head through MCP';

export default defineTool({
  name: 'extend_booking',
  title: { ru: 'Продлить бронь', uz: 'Bronni uzaytirish', en: 'Extend a booking' },
  description: 'Extends a live paid booking by the given hours (from its current deadline). The client is told. Requires the head\'s '
    + 'explicit confirmation: the first call returns a preview with the old and the new deadline.',
  input: z.strictObject({
    bookingNo: z.number().int().positive().describe('Booking number, e.g. 1042'),
    hours: z.number().int().min(1).max(720).describe('How many hours to add')
  }),
  output: z.object({ bookingNo: z.number().int(), apartmentNo: z.number().int(), until: z.string() }),
  roles: ['head'],
  sources: ['mcp'],
  mutates: true,
  async preview({ bookingNo, hours }, ctx) {
    const b = await bookingByNo(ctx, bookingNo);
    if (['hold_expired', 'expired', 'released', 'cancelled', 'converted'].includes(b.status)) throw new DomainError('booking_closed');
    if (b.status !== 'booked') throw new DomainError('booking_not_active');
    const to = new Date(b.expires_at.getTime() + hours * 3600e3);
    const s = await settingsOf(ctx.db, ctx.core);
    if (to.getTime() > ctx.now().getTime() + s.extend_max_hours * 3600e3) throw new DomainError('extend_too_long', { max: s.extend_max_hours });
    return { bookingNo, apartmentNo: b.apartment_no, hours, from: b.expires_at.toISOString(), to: to.toISOString() };
  },
  async run({ bookingNo, hours }, ctx) {
    const b = await bookingByNo(ctx, bookingNo);
    const r = await extend(ctx.db, { bookingId: b.id, hours, reason: REASON }, ctx.actor, ctx.core);
    return { bookingNo, apartmentNo: b.apartment_no, until: new Date(r.expires_at).toISOString() };
  }
});
