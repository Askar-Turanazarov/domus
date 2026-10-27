// book_viewing (08 §3.1, 03 §12): a viewing — only after the confirmation. Name and phone are arguments for MCP; in the chat
// they come from the client's card and the dialog memory (the model never sees the phone).
import { z } from 'zod';
import { defineTool } from './define.js';
import { previewViewing, scheduleViewing, tashkentText } from '../core/viewingsDb.js';
import { aptNo, redactPii } from './common.js';
import { contactOf } from './contact.js';

const own = (a, ctx) => (ctx.source === 'mcp' ? { phone: a.phone ?? null, name: a.name ?? null } : {});

export default defineTool({
  name: 'book_viewing',
  title: { ru: 'Записать на показ', uz: 'Ko‘rishga yozish', en: 'Book a viewing' },
  description: 'Books a viewing of an apartment at a date and time in Tashkent time (YYYY-MM-DDTHH:MM), 09:00–20:00, '
    + 'up to 60 days ahead. Needs the user\'s explicit confirmation: the first call returns a preview to show; '
    + 'it is executed only after the user agrees. name and phone are for MCP only; in the chat they come from the client card.',
  input: z.strictObject({
    no: aptNo.describe('Apartment number'),
    datetime: z.string().max(25).describe('Viewing time, Tashkent: YYYY-MM-DDTHH:MM'),
    name: z.string().max(60).optional().describe('Visitor name (MCP only)'),
    phone: z.string().max(25).optional().describe('Visitor phone (MCP only)')
  }),
  output: z.object({ viewingId: z.string(), apartmentNo: z.number().int(), at: z.string(), local: z.string() }),
  roles: ['client'],
  mutates: true,
  async preview(a, ctx) {
    await contactOf(ctx, { ...own(a, ctx), required: true });
    const p = await previewViewing(ctx.db, { apartmentNo: a.no, datetime: a.datetime }, ctx.core);
    return { apartmentNo: p.apartmentNo, at: p.at, local: p.local };
  },
  async run(a, ctx) {
    const c = await contactOf(ctx, { ...own(a, ctx), required: true });
    const v = await scheduleViewing(ctx.db, { apartmentNo: a.no, datetime: a.datetime, clientId: c.client.id,
      name: c.name, phone: c.phone, channel: ctx.actor.channel }, ctx.actor, ctx.core);
    const at = new Date(v.at);
    return { viewingId: v.id, apartmentNo: v.apartment_no, at: at.toISOString(), local: tashkentText(at) };
  },
  redact: redactPii
});
