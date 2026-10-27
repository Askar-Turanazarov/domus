// my_bookings (08 §3.1, §5): holds and bookings of THIS client only (merged cards too) — status, deadline, deposit, link.
import { z } from 'zod';
import { defineTool } from './define.js';
import { listBookings } from '../core/bookings.js';
import { getApartment } from '../core/apartments.js';
import { absolute } from './common.js';

export default defineTool({
  name: 'my_bookings',
  title: { ru: 'Мои брони', uz: 'Mening bronlarim', en: 'My bookings' },
  description: 'Lists the current client\'s own holds and bookings, newest first: booking number, apartment, rooms, area, floor, status '
    + '(held / booked / hold_expired / expired / cancelled / converted / released), deadline, deposit, personal booking page link. '
    + 'Payment is never started here: give the link.',
  input: z.strictObject({}),
  output: z.object({ items: z.array(z.object({ bookingNo: z.number().int() }).loose()) }),
  roles: ['client'],
  mutates: false,
  async run(_, ctx) {
    if (!ctx.actor.id) return { items: [] };                    // no card yet — nothing of theirs, never everybody's
    const rows = await listBookings(ctx.db, { clientId: ctx.actor.id, limit: 10 }, ctx.core);
    const apts = new Map();                                     // the card of the reply shows the apartment: rooms, area, floor
    for (const no of new Set(rows.map(b => b.apartment_no))) apts.set(no, await getApartment(ctx.db, no, ctx.core));
    return { items: rows.map(b => {
      const a = apts.get(b.apartment_no);
      return { bookingNo: b.no, apartmentNo: b.apartment_no, rooms: a?.rooms ?? null, area: a ? Number(a.area) : null, floor: a?.floor ?? null,
        status: b.status, until: new Date(b.expires_at).toISOString(), deposit: Number(b.deposit_amount), paid: Boolean(b.booked_at),
        link: absolute(b.link, ctx.env) };
    }) };
  }
});
