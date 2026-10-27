// request_extension (08 §3.1, 03 §6): «продлите бронь» — an event and a message to the group; the booking itself does not
// change. No confirmation: it only calls a staff member.
import { z } from 'zod';
import { defineTool } from './define.js';
import { DomainError } from '../core/errors.js';
import { requestExtension } from '../core/bookings.js';

export default defineTool({
  name: 'request_extension',
  title: { ru: 'Попросить продлить бронь', uz: 'Bronni uzaytirishni so‘rash', en: 'Ask to extend a booking' },
  description: 'Asks the sales team to extend one of the current client\'s own paid bookings. The booking is NOT extended by this call: '
    + 'a manager decides and contacts the client. A repeat within 10 minutes changes nothing.',
  input: z.strictObject({
    bookingNo: z.number().int().positive().describe('Booking number from my_bookings'),
    hours: z.number().int().min(1).max(720).optional().describe('How many hours the client asks for')
  }),
  output: z.object({ requested: z.boolean(), bookingNo: z.number().int(), until: z.string() }).loose(),
  roles: ['client'],
  mutates: false,
  async run({ bookingNo, hours }, ctx) {
    if (!ctx.actor.id) throw new DomainError('booking_not_found');
    return requestExtension(ctx.db, { bookingNo, hours: hours ?? null, clientId: ctx.actor.id }, ctx.actor, ctx.core);
  }
});
