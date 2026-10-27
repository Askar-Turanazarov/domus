// search_apartments (08 §3.1): Domus search, extended — ranges, building, sorting. Free by default, cheapest first.
import { z } from 'zod';
import { defineTool } from './define.js';
import { listApartments } from '../core/apartments.js';
import { sum, card } from './common.js';

const SORT = { price: a => a.price, pricePerM2: a => a.price / a.area, area: a => a.area };

export default defineTool({
  name: 'search_apartments',
  title: { ru: 'Поиск квартир', uz: 'Xonadonlarni qidirish', en: 'Search apartments' },
  description: 'Finds apartments of the residential complex by filters. Prices are whole UZS, area in m², rooms 0 = studio. '
    + 'Only free apartments unless status is "any"; sorted by price ascending unless sort is given. Returns the total count and the first items.',
  input: z.strictObject({
    rooms: z.number().int().min(0).max(6).optional().describe('Number of rooms, 0 = studio'),
    priceMin: sum.optional().describe('Minimum price, UZS'),
    priceMax: sum.optional().describe('Maximum price, UZS'),
    areaMin: z.number().positive().optional().describe('Minimum area, m²'),
    areaMax: z.number().positive().optional().describe('Maximum area, m²'),
    floorMin: z.number().int().min(1).max(60).optional().describe('Lowest floor'),
    floorMax: z.number().int().min(1).max(60).optional().describe('Highest floor'),
    building: z.string().max(40).optional().describe('Building id, e.g. "chinor-park"'),
    status: z.enum(['free', 'any']).optional().describe('free (default) — on sale; any — every apartment with its status'),
    sort: z.enum(['price', 'pricePerM2', 'area']).optional().describe('Sort key, ascending; default price'),
    limit: z.number().int().min(1).max(100).optional().describe('How many to return: up to 10 in chat, 100 via MCP')
  }),
  output: z.object({ total: z.number().int(), items: z.array(z.object({ no: z.number().int() }).loose()) }),
  roles: ['client', 'head'],
  mutates: false,
  async run(a, ctx) {
    const rows = await listApartments(ctx.db, { ...a, status: a.status === 'any' ? null : 'free' }, ctx.core);
    const key = SORT[a.sort ?? 'price'];
    rows.sort((x, y) => key(x) - key(y) || x.no - y.no);
    const limit = Math.min(a.limit ?? 10, ctx.source === 'agent' ? 10 : 100);
    return { total: rows.length, items: rows.slice(0, limit).map(r => card(r, ctx.lang, ctx.env)) };
  }
});
