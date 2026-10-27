// get_apartment (08 §3.1): the card of one apartment, with the 3D link.
import { z } from 'zod';
import { defineTool } from './define.js';
import { DomainError } from '../core/errors.js';
import { getApartment } from '../core/apartments.js';
import { aptNo, card } from './common.js';

export default defineTool({
  name: 'get_apartment',
  title: { ru: 'Квартира по номеру', uz: 'Raqam bo‘yicha xonadon', en: 'Apartment by number' },
  description: 'Returns one apartment by its number: floor, rooms, area, price and price per m² in UZS, status '
    + '(free / held / booked / sold), building and the link that opens it in 3D.',
  input: z.strictObject({ no: aptNo.describe('Apartment number, e.g. 41') }),
  output: z.object({ no: z.number().int(), price: z.number().int(), status: z.string(), url: z.string() }).loose(),
  roles: ['client', 'head'],
  mutates: false,
  async run({ no }, ctx) {
    const a = await getApartment(ctx.db, no, ctx.core);
    if (!a) throw new DomainError('apartment_not_found', { no });
    return card(a, ctx.lang, ctx.env);
  }
});
