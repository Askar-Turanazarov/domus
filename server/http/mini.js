// The mini app (10 §7, 11 §8, 13 §7): the page /mini — the showcase with data-mode="mini" and telegram-web-app.js —
// and /api/mini/*, the public entries with another way to know the client: X-Tg-Init-Data (Tg), channel = 'mini'.
import fs from 'node:fs';
import path from 'node:path';
import { DomainError } from '../core/errors.js';
import { createHold, effectiveStatus, settingsOf } from '../core/bookings.js';
import { statusMap } from '../core/apartments.js';
import { resolveClient, leaveContact } from '../core/clients.js';
import { startPayment } from '../core/payments.js';
import { bookingPath } from '../core/links.js';
import { context } from '../core/tx.js';
import { initDataChecker } from '../telegram/initData.js';
import { bookingByRef } from './bookings.js';
import { handler, jsonBody, parseBody, z, langOf, idempotencyKey, limit, ipKey, tz, sendError, HOUR } from './common.js';

const LANGS = ['ru', 'uz', 'en'];
const TG_SCRIPT = 'https://telegram.org/js/telegram-web-app.js';
// 14 §9: Telegram Web opens /mini in a frame — the frame is allowed to telegram.org only.
const FRAME = "frame-ancestors https://web.telegram.org https://*.telegram.org";

// The showcase page in the mini app mode (11 §8): the server marks <html> and adds the Telegram script
// (the page itself loads /js/mini.js, which does nothing outside the mini app).
export function miniPage(html) {
  return html
    .replace(/<html([^>]*)>/, (m, a) => `<html${a.replace(/\s*data-mode="[^"]*"/, '')} data-mode="mini">`)
    .replace('</head>', `  <script src="${TG_SCRIPT}"></script>\n</head>`);
}

const tgLang = code => (LANGS.includes(String(code ?? '').slice(0, 2)) ? String(code).slice(0, 2) : 'ru');

// opts — { env, onCommit, buildings, buildingId, publicDir, now } (the core options plus the showcase source).
export function mountMini(app, db, opts = {}) {
  const env = opts.env ?? process.env;
  const check = initDataChecker(env, opts.now ? { now: opts.now } : undefined);
  const publicDir = opts.publicDir ?? path.join(import.meta.dirname, '..', '..', 'public');
  let page = null;   // on Vercel the file never changes; locally an edited page is read again

  app.get('/mini', (req, res) => {
    if (!page || !process.env.VERCEL) page = miniPage(fs.readFileSync(path.join(publicDir, 'building.html'), 'utf8'));
    res.removeHeader('X-Frame-Options');
    res.set({ 'Cache-Control': 'no-cache', 'X-Robots-Tag': 'noindex, nofollow', 'Content-Security-Policy': FRAME }).type('html').send(page);
  });

  // Tg (13 §1.6): every /api/mini/* — the signature first, then the card of the Telegram user (R1).
  app.use('/api/mini', jsonBody, async (req, res, next) => {
    let user;
    try {
      ({ user } = check(req.get('x-tg-init-data')));
      const actor = { type: 'client', id: null, role: 'client', channel: 'mini' };
      const telegram = { userId: user.id, username: user.username ?? null };
      const name = [user.first_name, user.last_name].filter(Boolean).join(' ').slice(0, 200) || undefined;
      const client = await db.tx(q => resolveClient(q, { telegram, name, lang: tgLang(user.language_code) }, 'mini', actor, context(opts)));
      req.mini = { client, telegram, actor: { ...actor, id: client.id } };
    } catch (e) {
      res.set({ 'Cache-Control': 'no-store' });
      return sendError(res, e, langOf(req));
    }
    next();
  });

  const clientBookings = async (clientId, at) => {
    const rows = await db.query(`SELECT * FROM bookings WHERE client_id = $1 AND status IN ('held', 'booked', 'converted')
      ORDER BY held_at DESC LIMIT 20`, [clientId]);
    return rows.map(b => ({ no: b.no, apartmentNo: b.apartment_no, status: effectiveStatus(b, at), expiresAt: tz(b.expires_at),
      link: bookingPath(b, env) })).filter(b => b.status !== 'hold_expired');
  };

  // One request on start (11 §13.2): the building, the statuses, the client's holds, the card, the bookings, the hold terms.
  app.get('/api/mini/bootstrap', handler(async (req, res) => {
    const ctx = context(opts);
    const at = ctx.now();
    const c = req.mini.client;
    const [building, statuses, s, bookings] = await Promise.all([
      opts.buildings ? opts.buildings.get(opts.buildingId) : null, statusMap(db, ctx), settingsOf(db, ctx), clientBookings(c.id, at)
    ]);
    const mine = Object.fromEntries(bookings.filter(b => b.status === 'held').map(b => [b.apartmentNo, { link: b.link, expiresAt: b.expiresAt }]));
    res.json({ building, statuses, mine, client: { name: c.name ?? null, lang: c.lang ?? 'ru', phoneKnown: Boolean(c.phone) }, bookings,
      terms: { offerVersion: s.offer_version, depositAmount: Number(s.deposit_amount), holdMinutes: s.hold_minutes, bookingHours: s.booking_hours },
      at: tz(at) });
  }));

  app.get('/api/mini/bookings', handler(async (req, res) => {
    res.json({ items: await clientBookings(req.mini.client.id, context(opts).now()) });
  }));

  // 13 §7: as /api/bookings/hold, the client from initData; name and phone from the card when known, else from the body. No cookie.
  app.post('/api/mini/bookings/hold', handler(async (req, res) => {
    const body = parseBody({
      apartmentNo: z.number().int().min(1).max(100000),
      name: z.string().max(200).optional(),
      phone: z.string().max(40).optional(),
      consent: z.strictObject({ version: z.string().max(20), privacy: z.literal(true) }).optional(),
      lang: z.enum(LANGS).optional(),
      website: z.string().max(200).optional(), openedAt: z.union([z.string().max(40), z.number()]).optional()   // the site form's; the signature stands for them
    }, req.body);
    const key = idempotencyKey(req);
    const ctx = context(opts);
    const { client, telegram, actor } = req.mini;
    if (!client.phone && !body.phone) throw new DomainError('invalid_input', { fields: ['phone'] });
    await limit(db, `hold:ip:${ipKey(req, env)}`, 5, HOUR, ctx);
    await limit(db, `hold:client:${client.id}`, 3, HOUR, ctx);
    if (!client.phone || (!client.name && body.name)) await leaveContact(db, { clientId: client.id, name: body.name ?? null, phone: body.phone ?? client.phone }, ctx);
    const r = await createHold(db, {
      apartmentNo: body.apartmentNo, client: { telegram, lang: body.lang ?? langOf(req) },
      consent: body.consent ? { version: body.consent.version } : null, channel: 'mini', idempotencyKey: key
    }, actor, opts);
    res.status(201).json({ bookingNo: r.booking.no, link: r.link, expiresAt: tz(r.booking.expires_at), holdSeconds: r.holdSeconds,
      depositAmount: Number(r.booking.deposit_amount) });
  }));

  // 13 §7: as /api/payments; the booking of the ref must be the initData client's — someone else's answers as a wrong link.
  app.post('/api/mini/payments', handler(async (req, res) => {
    res.set({ 'Referrer-Policy': 'no-referrer' });
    const body = parseBody({
      ref: z.string().max(80), provider: z.enum(['card', 'click', 'stripe']),
      consent: z.strictObject({ version: z.string().max(20) }).optional(), lang: z.enum(LANGS).optional()
    }, req.body);
    const key = idempotencyKey(req);
    const b = await bookingByRef(db, body.ref, env);
    if (b.client_id !== req.mini.client.id) throw new DomainError('link_invalid');
    await limit(db, `pay:ref:${b.no}`, 10, HOUR, context(opts));
    const r = await startPayment(db, { target: { bookingId: b.id }, provider: body.provider, consent: body.consent ?? null,
      lang: body.lang ?? langOf(req), idempotencyKey: key }, req.mini.actor, opts);
    res.status(201).json(r);
  }));
}
