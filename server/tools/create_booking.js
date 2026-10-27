// create_booking (08 §2, §3.1, 03 §4): a hold for hold_minutes and the personal link — only after the confirmation.
// From the chat the hold is made without the form checkbox: the offer is accepted on the payment page (03 §4.4).
import { z } from 'zod';
import { defineTool } from './define.js';
import { DomainError } from '../core/errors.js';
import { previewHold, createHold } from '../core/bookings.js';
import { getApartment } from '../core/apartments.js';
import { aptNo, absolute } from './common.js';
import { contactOf } from './contact.js';

export default defineTool({
  name: 'create_booking',
  title: { ru: 'Забронировать квартиру', uz: 'Xonadonni bron qilish', en: 'Book an apartment' },
  description: 'Creates a short hold on a free apartment for the current client and returns a personal booking link where the '
    + 'deposit is paid. Requires the client\'s explicit confirmation: the first call returns a preview (price, deposit, hold minutes) '
    + 'to show; it is executed only after the client agrees. Never starts the payment.',
  input: z.strictObject({ apartmentNo: aptNo.describe('Apartment number, e.g. 41') }),
  output: z.object({ bookingNo: z.number().int(), apartmentNo: z.number().int(), holdUntil: z.string(), link: z.string() }),
  roles: ['client'],
  mutates: true,
  async preview({ apartmentNo }, ctx) {
    await contactOf(ctx);
    const p = await previewHold(ctx.db, { apartmentNo, clientId: ctx.actor.id }, ctx.core);
    if (!p.available) throw new DomainError(p.reason, { no: apartmentNo });
    const a = await getApartment(ctx.db, apartmentNo, ctx.core);
    return { apartmentNo, rooms: a.rooms, area: a.area, floor: a.floor, building: a.building, price: p.price, deposit: p.deposit,
      holdMinutes: p.holdMinutes, bookingHours: p.bookingHours };
  },
  async run({ apartmentNo }, ctx) {
    const c = await contactOf(ctx);
    const r = await createHold(ctx.db, { apartmentNo, client: { id: c.client.id }, channel: ctx.actor.channel,
      viaChat: ctx.source === 'agent', idempotencyKey: ctx.idempotencyKey ?? null }, ctx.actor, ctx.core);
    return { bookingNo: r.booking.no, apartmentNo, holdUntil: new Date(r.booking.expires_at).toISOString(), link: absolute(r.link, ctx.env) };
  }
});
