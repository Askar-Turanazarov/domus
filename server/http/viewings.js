// HTTP entries of a viewing (13 §5, 11 §7.2, J7): the slot grid of a day and the booking from the site form. The mini app
// (13 §7) uses the same two through mountMiniViewings with the client of initData. Every change is made by the core (03 §12).
import crypto from 'node:crypto';
import { DomainError } from '../core/errors.js';
import { scheduleViewing, tashkentText } from '../core/viewingsDb.js';
import { resolveClient, leaveContact } from '../core/clients.js';
import { normalizePhone } from '../core/phone.js';
import { linkVisitor } from '../core/analytics.js';
import { context, inTx } from '../core/tx.js';
import { t } from '../i18n/index.js';
import { handler, jsonBody, parseBody, z, langOf, idempotencyKey, limit, ipKey, hashKey, readDcl, setDcl, readDvid, HOUR, foreignOrigin, once } from './common.js';

const LANGS = ['ru', 'uz', 'en'];
const MIN_FILL_MS = 3000;                                   // 14 §6, as the hold form
const DAYS = 14;                                            // 11 §7.2: the nearest 14 days
const TZ_MS = 5 * 3600e3;
const SLOTS = Array.from({ length: 22 }, (_, i) => `${String(9 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);   // 09:00…19:30

// Today in Tashkent, 'YYYY-MM-DD'.
const today = at => new Date(at.getTime() + TZ_MS).toISOString().slice(0, 10);

// 13 §5: the grid of one day of one apartment → { date, slots: [{at: '15:00', free}] }. A slot is not free when it has passed,
// is taken by a scheduled viewing or the apartment is sold. Days outside the nearest 14 → err:datetime_too_far.
export async function slotsOf(db, { no, date }, ctx) {
  const at = ctx.now();
  const first = today(at);
  const last = today(new Date(at.getTime() + (DAYS - 1) * 864e5));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < first) throw new DomainError('datetime_invalid');
  if (date > last) throw new DomainError('datetime_too_far');
  const apt = await db.one('SELECT no, sold_at FROM apartments WHERE no = $1', [no]);
  if (!apt) throw new DomainError('apartment_not_found', { no });
  const from = new Date(`${date}T00:00+05:00`);
  const taken = new Set((await db.query(`SELECT at FROM viewings WHERE apartment_no = $1 AND status = 'scheduled' AND at >= $2 AND at < $3`,
    [no, from, new Date(from.getTime() + 864e5)])).map(r => tashkentText(new Date(r.at)).slice(11)));
  const slots = SLOTS.map(s => ({ at: s, free: !apt.sold_at && !taken.has(s) && new Date(`${date}T${s}+05:00`) > at }));
  return { date, days: DAYS, slots };
}

const answer = v => ({ viewing: { id: v.id, apartmentNo: v.apartment_no, at: new Date(v.at).toISOString(), local: tashkentText(new Date(v.at)) } });

// The same request sent twice (a lost answer, a double tap): the second meets the slot of the first; if that viewing is
// this client's, it is the answer (the base's one-viewing-per-slot index is the guard, 03 §12).
async function scheduleOnce(db, input, actor, opts) {
  try {
    return await scheduleViewing(db, input, actor, opts);
  } catch (e) {
    if (e.code !== 'slot_taken') throw e;
    const at = new Date(`${input.datetime}+05:00`);
    const own = await db.one(`SELECT * FROM viewings WHERE apartment_no = $1 AND at = $2 AND status = 'scheduled' AND client_id = $3`,
      [input.apartmentNo, at, input.clientId]);
    if (own) return own;
    throw e;
  }
}

const VIEW = {
  apartmentNo: z.number().int().min(1).max(100000),
  at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).max(16),       // Tashkent, to the minute
  name: z.string().max(200).optional(),
  phone: z.string().max(40).optional(),
  lang: z.enum(LANGS).optional(),
  website: z.string().max(200).optional(),
  openedAt: z.union([z.string().max(40), z.number()]).optional()
};

// opts — { env, onCommit, render } for the core.
export function mountViewings(app, db, opts = {}) {
  const env = opts.env ?? process.env;
  app.use('/api/viewings', jsonBody);

  app.get('/api/viewings/slots', handler(async (req, res) => {
    const no = Number(req.query.no);
    if (!Number.isInteger(no) || no < 1) throw new DomainError('invalid_input', { fields: ['no'] });
    res.set('Cache-Control', 'no-store').json(await slotsOf(db, { no, date: String(req.query.date ?? '') }, context(opts)));
  }));

  // 13 §5: the booking from the site form; the client by the rules of 03 §9.1 (cookie dcl + phone). A filled honeypot gets
  // a made-up 201 and nothing is written.
  app.post('/api/viewings', handler(async (req, res) => {
    if (foreignOrigin(req)) throw new DomainError('forbidden');
    const body = parseBody(VIEW, req.body);
    const ctx = context(opts);
    const lang = body.lang ?? langOf(req);
    if (body.website) {
      console.warn('spam.honeypot', req.path);
      return res.status(201).json({ viewing: { id: crypto.randomUUID(), apartmentNo: body.apartmentNo, at: new Date(`${body.at}+05:00`).toISOString(), local: body.at.replace('T', ' ') } });
    }
    const key = idempotencyKey(req);
    const opened = body.openedAt == null ? NaN : new Date(body.openedAt).getTime();
    if (Number.isFinite(opened) && ctx.now().getTime() - opened >= 0 && ctx.now().getTime() - opened < MIN_FILL_MS) {
      return res.status(422).json({ error: 'invalid_input', message: t(lang, 'err.form_too_fast'), vars: {}, fields: ['openedAt'], requestId: res.get('X-Request-Id') });
    }
    const phone = normalizePhone(body.phone);
    if (!phone) throw new DomainError(body.phone ? 'phone_invalid' : 'need_phone');
    const dcl = readDcl(req, env);
    await limit(db, `viewing:ip:${ipKey(req, env)}`, 5, HOUR, ctx);
    await limit(db, `viewing:phone:${hashKey(phone, env)}`, 3, HOUR, ctx);
    const out = await once(db, ctx, 'viewing', key, body, async () => {
      const actor = { type: 'client', id: null, role: 'client', channel: 'web' };
      const c = await inTx(db, ctx, q => resolveClient(q, { cookieId: dcl ?? undefined, name: body.name, phone, lang }, 'web', actor, ctx));
      const v = await scheduleOnce(db, { apartmentNo: body.apartmentNo, datetime: body.at, clientId: c.id, name: body.name ?? null, phone, channel: 'web' },
        { ...actor, id: c.id }, opts);
      return { status: 201, body: { ...answer(v), clientId: c.id } };
    });
    const { clientId, ...shown } = out.body;
    setDcl(res, req, clientId, env);
    await linkVisitor(db, { clientId, visitor: readDvid(req) });
    res.status(out.status).json(shown);
  }));
}

// 13 §7: /api/mini/viewings and /slots — after the initData check of mountMini (req.mini). Name and phone from the card when
// known, else from the body (then they are kept on the card, as the hold does).
export function mountMiniViewings(app, db, opts = {}) {
  const env = opts.env ?? process.env;
  app.get('/api/mini/viewings/slots', handler(async (req, res) => {
    const no = Number(req.query.no);
    if (!Number.isInteger(no) || no < 1) throw new DomainError('invalid_input', { fields: ['no'] });
    res.set('Cache-Control', 'no-store').json(await slotsOf(db, { no, date: String(req.query.date ?? '') }, context(opts)));
  }));

  app.post('/api/mini/viewings', handler(async (req, res) => {
    const body = parseBody(VIEW, req.body);
    const key = idempotencyKey(req);
    const ctx = context(opts);
    const { client, actor } = req.mini;
    if (!client.phone && !body.phone) throw new DomainError('need_phone');
    await limit(db, `viewing:ip:${ipKey(req, env)}`, 5, HOUR, ctx);
    await limit(db, `viewing:client:${client.id}`, 3, HOUR, ctx);
    const out = await once(db, ctx, 'viewing.mini', `${client.id}:${key}`, body, async () => {
      if (!client.phone || (!client.name && body.name)) await leaveContact(db, { clientId: client.id, name: body.name ?? null, phone: body.phone ?? client.phone }, ctx);
      const v = await scheduleOnce(db, { apartmentNo: body.apartmentNo, datetime: body.at, clientId: client.id, channel: 'mini' }, actor, opts);
      return { status: 201, body: answer(v) };
    });
    res.status(out.status).json(out.body);
  }));
}
