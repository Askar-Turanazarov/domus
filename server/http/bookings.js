// HTTP entries of a booking (13 §4): the hold from the site form and everything behind the personal link /b/<no>-<sig>.
// The entries only check the form, the limits and the link; every change is made by the core (BR-18).
import crypto from 'node:crypto';
import { DomainError } from '../core/errors.js';
import { createHold, recordConsent, releaseHold, cancel, effectiveStatus, settingsOf } from '../core/bookings.js';
import { getApartment, statusMap } from '../core/apartments.js';
import { normalizePhone } from '../core/phone.js';
import { parseRef, checkSig, bookingPath } from '../core/links.js';
import { issueLinkCode } from '../core/clients.js';
import { linkVisitor } from '../core/analytics.js';
import { context } from '../core/tx.js';
import { failureText, t } from '../i18n/index.js';
import { handler, jsonBody, parseBody, z, langOf, idempotencyKey, limit, ipKey, hashKey, readDcl, setDcl, readDvid, tz, HOUR, foreignOrigin } from './common.js';

const LANGS = ['ru', 'uz', 'en'];
const MIN_FILL_MS = 3000;                                    // 14 §6: a form filled faster than this is a script
const NEVER = { id: '00000000-0000-4000-8000-000000000000', access_version: 0 };

// The booking behind a personal link; a wrong number, a wrong signature or a rotated link all answer the same
// err:link_invalid, and the signature is compared even when no booking was found (13 §1.6, 15: the time does not tell).
export async function bookingByRef(db, ref, env = process.env) {
  const p = parseRef(ref);
  const row = p ? await db.one('SELECT * FROM bookings WHERE no = $1', [p.no]) : null;
  const ok = checkSig('booking', row ?? NEVER, p?.sig ?? '', env);
  if (!p || !row || !ok) throw new DomainError('link_invalid');
  return row;
}

// Whoever holds the link acts as the client of the booking (03 §14).
export const holderOf = b => ({ type: 'client', id: b.client_id, role: 'client', channel: 'web' });

const closedReason = b => ({
  hold_expired: 'hold_expired', released: 'released', expired: 'expired', converted: 'converted',
  cancelled: b.cancel_initiator === 'client' ? 'cancelled_client' : 'cancelled_developer'
})[b.status] ?? null;

// opts — { env, onCommit } for the core.
export function mountBookings(app, db, opts = {}) {
  const env = opts.env ?? process.env;
  app.use('/api/bookings', jsonBody);

  // 03 §4: the hold from the site form. A filled honeypot gets a made-up 201 and nothing is created.
  app.post('/api/bookings/hold', handler(async (req, res) => {
    if (foreignOrigin(req)) throw new DomainError('forbidden');      // 14 §15: a hold from another site's page
    const body = parseBody({
      apartmentNo: z.number().int().min(1).max(100000),
      name: z.string().max(200).optional(),
      phone: z.string().max(40).optional(),
      consent: z.strictObject({ version: z.string().max(20), privacy: z.literal(true) }).optional(),
      lang: z.enum(LANGS).optional(),
      website: z.string().max(200).optional(),
      openedAt: z.union([z.string().max(40), z.number()]).optional()
    }, req.body);
    const ctx = context(opts);
    if (body.website) {
      console.warn('spam.honeypot', req.path);
      return res.status(201).json({ bookingNo: 1000 + crypto.randomInt(9000), link: `/b/0-${crypto.randomBytes(24).toString('base64url').slice(0, 32)}`,
        expiresAt: tz(new Date(ctx.now().getTime() + 15 * 60e3)), holdSeconds: 900, depositAmount: 10_000_000 });
    }
    const key = idempotencyKey(req);
    const opened = body.openedAt == null ? NaN : new Date(body.openedAt).getTime();
    const lang = langOf(req);
    if (Number.isFinite(opened) && ctx.now().getTime() - opened >= 0 && ctx.now().getTime() - opened < MIN_FILL_MS) {
      return res.status(422).json({ error: 'invalid_input', message: t(lang, 'err.form_too_fast'), vars: {}, fields: ['openedAt'], requestId: res.get('X-Request-Id') });
    }
    const dcl = readDcl(req, env);
    const phone = normalizePhone(body.phone);
    await limit(db, `hold:ip:${ipKey(req, env)}`, 5, HOUR, ctx);
    if (phone) await limit(db, `hold:phone:${hashKey(phone, env)}`, 3, HOUR, ctx);
    if (dcl) await limit(db, `hold:client:${dcl}`, 3, HOUR, ctx);
    const r = await createHold(db, {
      apartmentNo: body.apartmentNo, client: { cookieId: dcl ?? undefined, name: body.name, phone: body.phone, lang },
      consent: body.consent ? { version: body.consent.version } : null, channel: 'web', idempotencyKey: key
    }, { type: 'client', id: null, role: 'client', channel: 'web' }, opts);
    setDcl(res, req, r.booking.client_id, env);
    await linkVisitor(db, { clientId: r.booking.client_id, visitor: readDvid(req) });
    res.status(201).json({ bookingNo: r.booking.no, link: r.link, expiresAt: tz(r.booking.expires_at), holdSeconds: r.holdSeconds,
      depositAmount: Number(r.booking.deposit_amount) });
  }));

  // 13 §3 (03 §2, 11 §3.2): the showcase map — no client, no deadline of others; `mine` — the holds of the client of the cookie.
  // `terms` — what the hold form shows and sends (the offer version must match, 03 §4.4).
  app.get('/api/apartments/status', handler(async (req, res) => {
    const ctx = context(opts);
    const dcl = readDcl(req, env);
    const at = ctx.now();
    const [statuses, s, held] = await Promise.all([
      statusMap(db, ctx), settingsOf(db, ctx),
      dcl ? db.query(`SELECT * FROM bookings WHERE client_id = $1 AND status = 'held' AND expires_at > $2`, [dcl, at]) : []
    ]);
    const mine = Object.fromEntries(held.map(b => [b.apartment_no, { link: bookingPath(b, env), expiresAt: tz(b.expires_at) }]));
    res.json({ statuses, ...(held.length ? { mine } : {}), at: tz(at),
      terms: { offerVersion: s.offer_version, depositAmount: Number(s.deposit_amount), holdMinutes: s.hold_minutes, bookingHours: s.booking_hours } });
  }));

  // 13 §4.1: what the booking page shows. No name and no phone: the link can be passed on (14 §4).
  app.get('/api/bookings/by-ref/:ref', handler(async (req, res) => {
    const ctx = context(opts);
    const b = await bookingByRef(db, req.params.ref, env);
    const lang = langOf(req);
    const at = ctx.now();
    const status = effectiveStatus(b, at);
    const [apt, s, pay, refund, client] = await Promise.all([
      getApartment(db, b.apartment_no, ctx), settingsOf(db, ctx),
      db.one('SELECT * FROM payments WHERE booking_id = $1 ORDER BY created_at DESC LIMIT 1', [b.id]),
      db.one(`SELECT r.* FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE p.booking_id = $1 ORDER BY r.created_at DESC LIMIT 1`, [b.id]),
      db.one('SELECT telegram_user_id FROM clients WHERE id = $1', [b.client_id])
    ]);
    res.json({
      booking: { no: b.no, status, expiresAt: tz(b.expires_at), depositAmount: Number(b.deposit_amount), consentVersion: b.consent_version,
        consentAt: tz(b.consent_at), extendedCount: b.extended_count, closedReason: closedReason({ ...b, status }) },
      apartment: { no: apt.no, floor: apt.floor, rooms: apt.rooms, area: Number(apt.area), price: Number(apt.price), status: apt.status },
      payment: pay && { id: pay.id, code: pay.code, provider: pay.provider, status: pay.status, brand: pay.card_brand, mask: pay.card_mask,
        failureReason: pay.failure_reason, failureText: failureText(pay.failure_reason, lang) },
      refund: refund && { status: refund.status, amount: Number(refund.amount), reason: refund.reason },
      offerVersion: s.offer_version,
      terms: { bookingHours: s.booking_hours, holdMinutes: s.hold_minutes },
      telegramLinked: Boolean(client?.telegram_user_id),
      serverNow: tz(at)
    });
  }));

  // The confirmation PDF (05 §10.4, 13 §4): only after the deposit was paid; built each time, never stored or cached (03 §14).
  app.get('/b/:ref/confirmation.pdf', handler(async (req, res) => {
    const ctx = context(opts);
    await limit(db, `pdf:ip:${ipKey(req, env)}`, 20, HOUR, ctx);
    const b = await bookingByRef(db, req.params.ref, env);
    const { bookingPdf } = await import('../payments/pdf.js');
    const pdf = await bookingPdf(db, b.id, { lang: LANGS.includes(req.query.lang) ? req.query.lang : undefined, env, now: ctx.now,
      base: env.PUBLIC_URL || `${req.protocol}://${req.get('host')}` });
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' })
      .attachment(pdf.filename).type('application/pdf').send(Buffer.from(pdf.bytes));
  }));

  app.post('/api/bookings/by-ref/:ref/consent', handler(async (req, res) => {
    const { version } = parseBody({ version: z.string().max(20) }, req.body);
    const b = await bookingByRef(db, req.params.ref, env);
    const r = await recordConsent(db, { bookingId: b.id, version }, holderOf(b), opts);
    res.json({ consentAt: tz(r.consent_at) });
  }));

  // 13 §4, 03 §9.1 R6: a one-time code (7 days) in a t.me link; the bot joins the site card with the Telegram user (/start lk_<code>).
  app.post('/api/bookings/by-ref/:ref/telegram-link', handler(async (req, res) => {
    parseBody({}, req.body);
    const ctx = context(opts);
    const bot = String(env.TELEGRAM_BOT_USERNAME ?? '').replace(/^@/, '');
    if (!bot || !env.TELEGRAM_BOT_TOKEN) throw new DomainError('feature_disabled');
    const b = await bookingByRef(db, req.params.ref, env);
    await limit(db, `tglink:booking:${b.id}`, 5, HOUR, ctx);
    const code = await db.tx(q => issueLinkCode(q, { clientId: b.client_id, bookingId: b.id }, ctx));
    res.json({ url: `https://t.me/${bot}?start=lk_${code}` });
  }));

  app.post('/api/bookings/by-ref/:ref/release', handler(async (req, res) => {
    parseBody({}, req.body);
    const b = await bookingByRef(db, req.params.ref, env);
    await releaseHold(db, { bookingId: b.id }, holderOf(b), opts);
    res.json({ status: 'released' });
  }));

  // 03 §7.2: the client gives up a paid booking; the deposit stays (BR-11).
  app.post('/api/bookings/by-ref/:ref/cancel', handler(async (req, res) => {
    const { reason } = parseBody({ reason: z.string().max(300).optional() }, req.body);
    const b = await bookingByRef(db, req.params.ref, env);
    await cancel(db, { bookingId: b.id, initiator: 'client', reason: reason ?? t(langOf(req), 'booking.client_cancel') }, holderOf(b), opts);
    res.json({ status: 'cancelled' });
  }));
}
