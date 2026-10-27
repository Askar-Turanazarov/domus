// Bookings (03 §3–7): hold → payment → booking, extension, cancellation, expiry. Every move from held/booked
// is made under SELECT … FOR UPDATE of the booking row; closed bookings never change (err:booking_closed).
import crypto from 'node:crypto';
import { DomainError, need, staffIdOf, reasonOf } from './errors.js';
import { DEFAULT_SETTINGS } from './defaults.js';
import { emit } from './events.js';
import { cancel as cancelJobs } from './jobs.js';
import { resolveClient } from './clients.js';
import { getApartment } from './apartments.js';
import { bookingPath } from './links.js';
import { maskPhone } from './phone.js';
import { requestRefund } from './refunds.js';
import { context, inTx, notify, later } from './tx.js';
import { closeOpenPayments } from './payments.js';

const ACTIVE = ['held', 'booked'];
const BROWSER = ['web', 'mini'];                 // the hold form there has the offer checkbox (§4.4)
const iso = d => new Date(d).toISOString();
const minutes = m => m * 60e3;

// Business settings inside the transaction: ctx.settings (createSettings) or the table over the defaults.
export async function settingsOf(q, ctx) {
  if (ctx.settings) return ctx.settings.get();
  const rows = await q.query('SELECT key, value FROM settings');
  return { ...DEFAULT_SETTINGS, ...Object.fromEntries(rows.filter(r => r.key in DEFAULT_SETTINGS).map(r => [r.key, r.value])) };
}

async function lockBooking(q, id) {
  const b = await q.one('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [id]);
  if (!b) throw new DomainError('booking_not_found');
  return b;
}

// held/booked with the deadline still ahead; otherwise the booking is over (even if not swept yet).
const live = (b, at) => ACTIVE.includes(b.status) && b.expires_at > at;

function owns(actor, b) {
  if (actor?.type === 'client' && actor.id && actor.id !== b.client_id) throw new DomainError('forbidden');
}

const staffName = async (q, id) => (id && (await q.one('SELECT name FROM staff WHERE id = $1', [id]))?.name) || '';

// The status as every read must see it (I12): an expired but not yet swept booking is already over.
export function effectiveStatus(b, at) {
  if (b.status === 'held' && b.expires_at <= at) return 'hold_expired';
  if (b.status === 'booked' && b.expires_at <= at) return 'expired';
  return b.status;
}

export async function getBooking(q, id, opts = {}) {
  const ctx = context(opts);
  const b = await q.one('SELECT * FROM bookings WHERE id = $1', [id]);
  return b && { ...b, status: effectiveStatus(b, ctx.now()) };
}

// Open payments of a closed hold (05 §7.3): cancelled now; Stripe also gets payment.reconcile.
const reconcilePayments = (q, fx, ctx, bookingId, why = 'booking_closed') => closeOpenPayments(q, fx, ctx, { bookingId, why });

// T3 / T7 for rows the sweep has just closed: event, messages, jobs.
async function afterSweep(q, fx, ctx, rows) {
  const sys = { type: 'system', id: null, role: 'system', channel: 'system' };
  for (const b of rows) {
    const refs = { bookingId: b.id, apartmentNo: b.apartment_no, clientId: b.client_id };
    if (b.status === 'hold_expired') {
      const ev = await emit(q, 'booking.hold_expired', refs, { expiresAt: iso(b.expires_at) }, sys, ctx);
      await cancelJobs(q, { type: 'hold.expire', bookingId: b.id }, ctx);
      await reconcilePayments(q, fx, ctx, b.id, 'hold_expired');
      await notify(q, fx, ctx, { template: 'hold_expired', audience: 'client', clientId: b.client_id, vars: { apt: b.apartment_no },
        eventId: ev, dedupeKey: `hold_expired:${b.id}` });
    } else {
      const ev = await emit(q, 'booking.expired', refs, { expiresAt: iso(b.expires_at) }, sys, ctx);
      for (const type of ['booking.remind', 'booking.expire']) await cancelJobs(q, { type, bookingId: b.id }, ctx);
      const c = await q.one('SELECT name, phone FROM clients WHERE id = $1', [b.client_id]);
      await notify(q, fx, ctx, { template: 'booking_expired', audience: 'client', clientId: b.client_id, vars: { apt: b.apartment_no },
        eventId: ev, dedupeKey: `booking_expired:${b.id}` });
      await notify(q, fx, ctx, { template: 'staff_booking_expired', audience: 'staff_group',
        vars: { bookingNo: b.no, apt: b.apartment_no, name: c?.name ?? '', phoneMasked: maskPhone(c?.phone) ?? '' },
        eventId: ev, dedupeKey: `staff_booking_expired:${b.id}` });
    }
  }
  return rows;
}

// Sweep (03 §3): held → hold_expired, booked → expired for everything past its deadline. closed_at = expires_at —
// the booking burnt at its deadline, however late we noticed. Inside the caller's transaction.
export async function sweepExpired(q, fx, ctx, { apartmentNo = null, clientId = null, bookingId = null, limit = 50 } = {}) {
  const rows = await q.query(`UPDATE bookings
       SET status = CASE status WHEN 'held' THEN 'hold_expired' ELSE 'expired' END,
           closed_at = expires_at, updated_at = $1, version = version + 1
     WHERE id IN (SELECT id FROM bookings
                   WHERE status IN ('held', 'booked') AND expires_at <= $1
                     AND ($2::int IS NULL OR apartment_no = $2) AND ($3::uuid IS NULL OR client_id = $3)
                     AND ($4::uuid IS NULL OR id = $4)
                   ORDER BY expires_at LIMIT $5 FOR UPDATE SKIP LOCKED)
    RETURNING *`, [ctx.now(), apartmentNo, clientId, bookingId, limit]);
  return afterSweep(q, fx, ctx, rows);
}

// The tick and the daily Cron (04 §5): sweep in its own transaction. → closed rows.
export async function sweepDue(db, { limit = 20 } = {}, opts = {}) {
  const ctx = context(opts);
  return inTx(db, ctx, (q, fx) => sweepExpired(q, fx, ctx, { limit }));
}

// What a hold would be (the agent's confirmation, the hold form): terms and whether it is possible now.
// → { apartmentNo, price, status, deposit, holdMinutes, bookingHours, offerVersion, available, reason }
export async function previewHold(q, { apartmentNo, clientId = null }, opts = {}) {
  const ctx = context(opts);
  const s = await settingsOf(q, ctx);
  const apt = await getApartment(q, apartmentNo, ctx);
  if (!apt) throw new DomainError('apartment_not_found', { no: apartmentNo });
  let reason = null;
  if (apt.status === 'sold') reason = 'apartment_sold';
  else if (apt.booking_client_id && apt.booking_client_id === clientId) reason = apt.status === 'booked' ? 'already_booked_by_you' : null;
  else if (apt.status !== 'free') reason = 'apartment_not_free';
  if (!reason && clientId && apt.booking_client_id !== clientId && await activeCount(q, clientId, ctx.now()) + 1 > s.max_active_bookings) {
    reason = 'booking_limit';
  }
  return { apartmentNo, price: apt.price, status: apt.status, deposit: s.deposit_amount, holdMinutes: s.hold_minutes,
    bookingHours: s.booking_hours, offerVersion: s.offer_version, available: !reason, reason };
}

// BR-06: active bookings of the client plus those of other unmerged cards with the same phone.
async function activeCount(q, clientId, at) {
  const r = await q.one(`SELECT count(*)::int AS n FROM bookings b JOIN clients c ON c.id = b.client_id
    WHERE b.status IN ('held', 'booked') AND b.expires_at > $1
      AND (b.client_id = $2 OR (c.merged_into IS NULL AND c.phone IS NOT NULL
           AND c.phone = (SELECT phone FROM clients WHERE id = $2)))`, [at, clientId]);
  return r.n;
}

function holdResult(b, ctx) {
  const left = b.status === 'held' ? Math.max(0, Math.round((b.expires_at - ctx.now()) / 1000)) : 0;
  return { booking: b, link: bookingPath(b, ctx.env), holdSeconds: left };
}

// T1 (03 §4): one transaction. input — { apartmentNo, client: {id?, cookieId?, name?, phone?, telegram?}, consent: {version} | null,
// channel, idempotencyKey? }. → { booking, link, holdSeconds }.
export async function createHold(db, input, actor, opts = {}) {
  // viaChat — made by a chat agent after «Да» (§4.1, §4.4): no form checkbox even on the site; consent on the payment page.
  const { apartmentNo, client: who = {}, consent = null, channel, idempotencyKey = null, viaChat = false } = input;
  if (!Number.isInteger(apartmentNo) || !channel) throw new DomainError('invalid_input');
  const ctx = context(opts);
  const hash = crypto.createHash('sha256').update(JSON.stringify({ apartmentNo, who, consent, channel })).digest('hex');
  return inTx(db, ctx, async (q, fx) => {
    const at = ctx.now();
    const s = await settingsOf(q, ctx);
    if (idempotencyKey) {                                                                       // 1
      const k = await q.one(`SELECT * FROM idempotency_keys WHERE scope = 'hold' AND key = $1 FOR UPDATE`, [idempotencyKey]);
      if (k && k.request_hash !== hash) throw new DomainError('idempotency_conflict');
      if (k) return holdResult(await q.one('SELECT * FROM bookings WHERE id = $1', [k.response.bookingId]), ctx);
    }
    if (consent && consent.version !== s.offer_version) throw new DomainError('consent_required');
    if (BROWSER.includes(channel) && !consent && !viaChat) throw new DomainError('consent_required');
    const client = await resolveClient(q, who, channel, actor, ctx);                            // 2
    await q.query('SELECT id FROM clients WHERE id = $1 FOR UPDATE', [client.id]);
    const apt = await q.one('SELECT * FROM apartments WHERE no = $1 FOR UPDATE', [apartmentNo]); // 3
    if (!apt) throw new DomainError('apartment_not_found', { no: apartmentNo });
    if (apt.sold_at) throw new DomainError('apartment_sold', { no: apartmentNo });
    await sweepExpired(q, fx, ctx, { apartmentNo });                                            // 4
    const cur = await q.one(`SELECT * FROM bookings WHERE apartment_no = $1 AND status IN ('held', 'booked')`, [apartmentNo]);
    if (cur?.client_id === client.id) {                                                         // 5
      if (cur.status === 'booked') throw new DomainError('already_booked_by_you', { no: apartmentNo });
      return holdResult(cur, ctx);
    }
    if (cur) throw new DomainError('apartment_not_free', { no: apartmentNo, until: cur.status === 'held' ? iso(cur.expires_at) : null }); // 6
    const replaced = await q.query(`UPDATE bookings SET status = 'released', closed_at = $2, updated_at = $2, version = version + 1
      WHERE client_id = $1 AND status = 'held' AND expires_at > $2 RETURNING *`, [client.id, at]);       // 7
    for (const r of replaced) {
      await emit(q, 'booking.released', { bookingId: r.id, apartmentNo: r.apartment_no, clientId: r.client_id }, { reason: 'replaced' }, actor, ctx);
      await cancelJobs(q, { type: 'hold.expire', bookingId: r.id }, ctx);
      await reconcilePayments(q, fx, ctx, r.id);
    }
    if (await activeCount(q, client.id, at) + 1 > s.max_active_bookings) {                     // 8
      throw new DomainError('booking_limit', { max: s.max_active_bookings });
    }
    const until = new Date(at.getTime() + minutes(s.hold_minutes));
    let b;
    try {                                                                                        // 9
      b = await q.one(`INSERT INTO bookings (apartment_no, client_id, status, channel, created_by, expires_at, held_at,
          deposit_amount, price_at_booking, consent_version, consent_at, updated_at)
        VALUES ($1, $2, 'held', $3, $4, $5, $6, $7, $8, $9, $10, $6) RETURNING *`,
      [apartmentNo, client.id, channel, JSON.stringify(actor), until, at, s.deposit_amount, apt.price,
        consent?.version ?? null, consent ? at : null]);
    } catch (e) {
      if (e.code === '23505') throw new DomainError('apartment_not_free', { no: apartmentNo });
      throw e;
    }
    const ev = await emit(q, 'booking.held', { bookingId: b.id, apartmentNo, clientId: client.id, staffId: staffIdOf(actor) },
      { channel, expiresAt: iso(until), deposit: b.deposit_amount }, actor, ctx);                // 10
    await later(q, fx, ctx, 'hold.expire', until, { bookingId: b.id, expectedExpiresAt: iso(until) }, `hold.expire:${b.id}:${iso(until)}`);
    if (!BROWSER.includes(channel)) {
      await notify(q, fx, ctx, { template: 'hold_created', audience: 'client', clientId: client.id,
        vars: { apt: apartmentNo, min: s.hold_minutes, deposit: b.deposit_amount, holdUntil: iso(until), link: bookingPath(b, ctx.env) },
        eventId: ev, dedupeKey: `hold_created:${b.id}` });
    }
    if (idempotencyKey) {                                                                       // 11
      await q.query(`INSERT INTO idempotency_keys (scope, key, request_hash, status, response, created_at)
        VALUES ('hold', $1, $2, 201, $3, $4) ON CONFLICT DO NOTHING`, [idempotencyKey, hash, JSON.stringify({ bookingId: b.id }), at]);
    }
    return holdResult(b, ctx);                                                                  // 12
  });
}

// The offer checkbox on the payment page (§4.4) for holds made in a chat. Repeating is harmless.
export async function recordConsent(db, { bookingId, version }, actor, opts = {}) {
  const ctx = context(opts);
  return inTx(db, ctx, async q => {
    const at = ctx.now();
    const s = await settingsOf(q, ctx);
    if (version !== s.offer_version) throw new DomainError('consent_required');
    const b = await lockBooking(q, bookingId);
    owns(actor, b);
    if (!live(b, at)) throw new DomainError('booking_closed');
    if (b.status !== 'held') throw new DomainError('booking_not_active');
    if (b.consent_version === version) return b;
    return q.one('UPDATE bookings SET consent_version = $2, consent_at = $3, updated_at = $3 WHERE id = $1 RETURNING *', [b.id, version, at]);
  });
}

// T4: the client gives up the hold («Отменить оформление»).
export async function releaseHold(db, { bookingId }, actor, opts = {}) {
  const ctx = context(opts);
  return inTx(db, ctx, async (q, fx) => {
    const at = ctx.now();
    const b = await lockBooking(q, bookingId);
    owns(actor, b);
    if (!live(b, at)) throw new DomainError('booking_closed');
    if (b.status !== 'held') throw new DomainError('booking_not_active');
    const r = await q.one(`UPDATE bookings SET status = 'released', closed_at = $2, updated_at = $2, version = version + 1
      WHERE id = $1 RETURNING *`, [b.id, at]);
    await emit(q, 'booking.released', { bookingId: b.id, apartmentNo: b.apartment_no, clientId: b.client_id }, { reason: 'client' }, actor, ctx);
    await cancelJobs(q, { type: 'hold.expire', bookingId: b.id }, ctx);
    await reconcilePayments(q, fx, ctx, b.id);
    return r;
  });
}

// booking.expire at the deadline and reminders still ahead (more than 30 s left, 04 §6.1).
async function scheduleBookingJobs(q, fx, ctx, b, s) {
  const at = ctx.now().getTime();
  const exp = iso(b.expires_at);
  await later(q, fx, ctx, 'booking.expire', b.expires_at, { bookingId: b.id, expectedExpiresAt: exp }, `booking.expire:${b.id}:${exp}`);
  for (const h of s.reminders.bookingHoursBefore) {
    const runAt = new Date(b.expires_at.getTime() - h * 3600e3);
    if (runAt.getTime() - at > 30e3) {
      await later(q, fx, ctx, 'booking.remind', runAt, { bookingId: b.id, expectedExpiresAt: exp, hoursBefore: h },
        `booking.remind:${b.id}:${exp}:${h}`);
    }
  }
}

// T2 (03 §5): called only by the payment layer inside its transaction, after the deposit payment succeeded.
// late — Stripe paid a payment already closed (05 §6.7). → 'booked' | 'late' | 'duplicate'; the payment layer
// then sets the payment status and asks for the refund (05 §7.1).
export async function confirmPaid(q, fx, ctx, { bookingId, payment, late = false }) {
  const at = ctx.now();
  const b = await lockBooking(q, bookingId);
  const refs = { bookingId: b.id, apartmentNo: b.apartment_no, clientId: b.client_id, paymentId: payment.id };
  const sys = { type: 'system', id: null, role: 'system', channel: 'system' };
  if (late || !(b.status === 'held' && b.expires_at > at)) {
    const result = !late && b.status === 'booked' ? 'duplicate' : 'late';
    const ev = await emit(q, 'payment.late', refs, { reason: result === 'late' ? 'late_payment' : 'duplicate_payment', amount: payment.amount }, sys, ctx);
    const apt = await getApartment(q, b.apartment_no, ctx);
    await notify(q, fx, ctx, { template: 'payment_late', audience: 'client', clientId: b.client_id,
      vars: { apt: b.apartment_no, amount: payment.amount, aptFree: apt?.status === 'free' }, eventId: ev, dedupeKey: `payment_late:${payment.id}` });
    return result;
  }
  const s = await settingsOf(q, ctx);
  const booked = await q.one(`UPDATE bookings SET status = 'booked', booked_at = $2, expires_at = $3, updated_at = $2, version = version + 1
    WHERE id = $1 RETURNING *`, [b.id, at, new Date(at.getTime() + s.booking_hours * 3600e3)]);
  await cancelJobs(q, { type: 'hold.expire', bookingId: b.id }, ctx);
  const ev = await emit(q, 'booking.paid', refs,
    { amount: payment.amount, provider: payment.provider, paymentCode: payment.code, expiresAt: iso(booked.expires_at) }, sys, ctx);
  await scheduleBookingJobs(q, fx, ctx, booked, s);
  const link = bookingPath(booked, ctx.env);
  await notify(q, fx, ctx, { template: 'booking_confirmed', audience: 'client', clientId: b.client_id,
    vars: { apt: b.apartment_no, until: iso(booked.expires_at), bookingNo: b.no, deposit: b.deposit_amount, link },
    eventId: ev, dedupeKey: `booking_confirmed:${b.id}` });
  const c = await q.one('SELECT * FROM clients WHERE id = $1', [b.client_id]);
  const apt = await q.one('SELECT rooms, area, price FROM apartments WHERE no = $1', [b.apartment_no]);
  await notify(q, fx, ctx, { template: 'staff_booking_paid', audience: 'staff_group',
    vars: { bookingNo: b.no, apt: b.apartment_no, rooms: apt.rooms, area: apt.area, price: b.price_at_booking, name: c.name ?? '',
      phoneMasked: maskPhone(c.phone) ?? '', channel: b.channel, deposit: b.deposit_amount, provider: payment.provider,
      until: iso(booked.expires_at), context: c.lead_summary ?? '', clientId: c.id, bookingId: b.id },
    eventId: ev, dedupeKey: `staff_booking_paid:${b.id}` });
  return 'booked';
}

// T6 (03 §6): manager or head; reason; only a live booked booking; not shorter, not past now + extend_max_hours.
// { bookingId, hours | until, reason, expectedVersion } → the booking.
export async function extend(db, { bookingId, hours, until, reason, expectedVersion }, actor, opts = {}) {
  need(actor, 'manager', 'head');
  const why = reasonOf(reason);
  const ctx = context(opts);
  return inTx(db, ctx, async (q, fx) => {
    const at = ctx.now();
    const s = await settingsOf(q, ctx);
    const b = await lockBooking(q, bookingId);
    if (!live(b, at)) throw new DomainError('booking_closed');
    if (b.status !== 'booked') throw new DomainError('booking_not_active');
    if (expectedVersion != null && expectedVersion !== b.version) throw new DomainError('stale');
    const to = until != null ? new Date(until)
      : Number.isFinite(hours) && hours > 0 ? new Date(b.expires_at.getTime() + hours * 3600e3) : null;
    if (!to || Number.isNaN(to.getTime()) || to <= b.expires_at) throw new DomainError('invalid_input');
    if (to.getTime() > at.getTime() + s.extend_max_hours * 3600e3) throw new DomainError('extend_too_long', { max: s.extend_max_hours });
    const r = await q.one(`UPDATE bookings SET expires_at = $2, extended_count = extended_count + 1, updated_at = $3, version = version + 1
      WHERE id = $1 RETURNING *`, [b.id, to, at]);
    for (const type of ['booking.remind', 'booking.expire']) await cancelJobs(q, { type, bookingId: b.id }, ctx);
    await scheduleBookingJobs(q, fx, ctx, r, s);
    const ev = await emit(q, 'booking.extended', { bookingId: b.id, apartmentNo: b.apartment_no, clientId: b.client_id, staffId: staffIdOf(actor) },
      { from: iso(b.expires_at), to: iso(to), reason: why, hours: Math.round((to - b.expires_at) / 3600e3) }, actor, ctx);
    await notify(q, fx, ctx, { template: 'booking_extended', audience: 'client', clientId: b.client_id,
      vars: { apt: b.apartment_no, until: iso(to), link: bookingPath(r, ctx.env) }, eventId: ev, dedupeKey: `booking_extended:${b.id}:${iso(to)}` });
    await notify(q, fx, ctx, { template: 'staff_booking_extended', audience: 'staff_group',
      vars: { bookingNo: b.no, until: iso(to), staffName: await staffName(q, staffIdOf(actor)), reason: why },
      eventId: ev, dedupeKey: `staff_booking_extended:${b.id}:${iso(to)}` });
    return r;
  });
}

// T5 / T8 (03 §7): initiator client — the deposit stays (BR-11); developer — full refund at once (BR-12).
// A hold can be cancelled only as developer (nothing paid). A client may cancel only their own booked booking.
export async function cancel(db, { bookingId, initiator, reason, expectedVersion }, actor, opts = {}) {
  if (actor?.type === 'client') {
    need(actor, 'client');
    initiator = 'client';
  } else need(actor, 'manager', 'head');
  if (!['client', 'developer'].includes(initiator)) throw new DomainError('invalid_input');
  const why = reasonOf(reason);
  const ctx = context(opts);
  return inTx(db, ctx, async (q, fx) => {
    const at = ctx.now();
    const b = await lockBooking(q, bookingId);
    owns(actor, b);
    if (!live(b, at)) throw new DomainError('booking_closed');
    if (expectedVersion != null && expectedVersion !== b.version) throw new DomainError('stale');
    if (b.status === 'held' && (initiator !== 'developer' || actor.type === 'client')) throw new DomainError('booking_not_active');
    const r = await q.one(`UPDATE bookings SET status = 'cancelled', cancel_initiator = $2, cancel_reason = $3, closed_at = $4,
      updated_at = $4, version = version + 1 WHERE id = $1 RETURNING *`, [b.id, initiator, why, at]);
    const refs = { bookingId: b.id, apartmentNo: b.apartment_no, clientId: b.client_id, staffId: staffIdOf(actor) };
    if (b.status === 'held') {
      await cancelJobs(q, { type: 'hold.expire', bookingId: b.id }, ctx);
      await reconcilePayments(q, fx, ctx, b.id);
      const ev = await emit(q, 'booking.cancelled', refs, { initiator, reason: why, depositFate: 'none' }, actor, ctx);
      await notify(q, fx, ctx, { template: 'hold_cancelled', audience: 'client', clientId: b.client_id,
        vars: { apt: b.apartment_no, reason: why }, eventId: ev, dedupeKey: `hold_cancelled:${b.id}` });
      return r;
    }
    for (const type of ['booking.remind', 'booking.expire']) await cancelJobs(q, { type, bookingId: b.id }, ctx);
    const fate = initiator === 'developer' ? 'refund' : 'kept';
    const ev = await emit(q, 'booking.cancelled', refs, { initiator, reason: why, depositFate: fate }, actor, ctx);
    if (fate === 'refund') {
      const paid = await q.one(`SELECT id FROM payments WHERE booking_id = $1 AND kind = 'deposit' AND status = 'succeeded'`, [b.id]);
      if (paid) await requestRefund(q, fx, ctx, { paymentId: paid.id, reason: 'developer_cancel', actor: { type: 'system', id: null, role: 'system', channel: 'system' } });
    }
    await notify(q, fx, ctx, { template: 'booking_cancelled', audience: 'client', clientId: b.client_id,
      vars: { apt: b.apartment_no, reason: why, initiator, deposit: b.deposit_amount }, eventId: ev, dedupeKey: `booking_cancelled:${b.id}` });
    await notify(q, fx, ctx, { template: 'staff_booking_cancelled', audience: 'staff_group',
      vars: { bookingNo: b.no, initiator, reason: why, fate }, eventId: ev, dedupeKey: `staff_booking_cancelled:${b.id}` });
    return r;
  });
}

// Job handlers for runDue (04 §6.1). Each checks the booking still is what the job was set for, else 'skipped'.
// Outbox rows and new jobs gathered in fx are delivered / published by the caller after the run.
export function bookingJobHandlers(opts = {}) {
  const fx = { outbox: [], jobs: [] };
  const expire = status => async (job, { q, now }) => {
    const ctx = context({ ...opts, now });
    const b = await q.one('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [job.payload.bookingId]);
    if (!b || b.status !== status || iso(b.expires_at) !== job.payload.expectedExpiresAt) return 'skipped';
    if (b.expires_at > now()) throw new Error('not due yet');            // early by the claim slack: retried shortly
    await sweepExpired(q, fx, ctx, { bookingId: b.id });
    return 'done';
  };
  const handlers = {
    'hold.expire': expire('held'),
    'booking.expire': expire('booked'),
    'booking.remind': async (job, { q, now }) => {
      const ctx = context({ ...opts, now });
      const { bookingId, expectedExpiresAt, hoursBefore } = job.payload;
      const b = await q.one('SELECT * FROM bookings WHERE id = $1', [bookingId]);
      const at = now();
      if (!b || b.status !== 'booked' || iso(b.expires_at) !== expectedExpiresAt || b.expires_at <= at) return 'skipped';
      const c = await q.one('SELECT assigned_staff_id FROM clients WHERE id = $1', [b.client_id]);
      await notify(q, fx, ctx, { template: 'booking_reminder', audience: 'client', clientId: b.client_id,
        vars: { apt: b.apartment_no, until: expectedExpiresAt, hours: hoursBefore, link: bookingPath(b, ctx.env) },
        dedupeKey: `booking_reminder:${b.id}:${expectedExpiresAt}:${hoursBefore}` });
      if (hoursBefore >= 24) {
        await notify(q, fx, ctx, { template: 'staff_booking_expiring', audience: 'staff_group',
          vars: { bookingNo: b.no, apt: b.apartment_no, until: expectedExpiresAt, staffName: await staffName(q, c?.assigned_staff_id) },
          dedupeKey: `staff_booking_expiring:${b.id}:${expectedExpiresAt}` });
      }
      return 'done';
    }
  };
  return { handlers, fx };
}

// The bookings of a client (my_bookings, 08 §3.1) with the cards merged into it (§9), newest first; statuses as reads
// must see them (I12). Head filter (list_bookings, 08 §3.2): expiring within N hours.
export async function listBookings(q, { clientId = null, status = null, expiringWithinHours = null, limit = 20 } = {}, opts = {}) {
  const ctx = context(opts);
  const at = ctx.now();
  const soon = expiringWithinHours ? new Date(at.getTime() + expiringWithinHours * 3600e3) : null;
  const rows = await q.query(`SELECT * FROM bookings b
    WHERE ($1::uuid IS NULL OR b.client_id IN (SELECT id FROM clients WHERE id = $1 OR merged_into = $1))
      AND ($2::timestamptz IS NULL OR (b.status IN ('held', 'booked') AND b.expires_at > $3 AND b.expires_at <= $2))
    ORDER BY b.held_at DESC, b.no DESC LIMIT $4`, [clientId, soon, at, limit]);
  const out = rows.map(b => ({ ...b, status: effectiveStatus(b, at), link: bookingPath(b, ctx.env) }));
  return status ? out.filter(b => b.status === status) : out;
}

const DEDUPE_MS = 10 * 60e3;

// «Продлите бронь» through the agent (03 §6, 08 §3.1): the agent cannot extend (PRD 4.2) — an event and a message to
// the group; the booking itself does not change. Only the client's own live booking: someone else's number →
// booking_not_found (08 §5). A repeat within 10 minutes → the same answer without a new message.
export async function requestExtension(db, { bookingNo, hours = null, clientId }, actor, opts = {}) {
  const ctx = context(opts);
  return inTx(db, ctx, async (q, fx) => {
    const at = ctx.now();
    const b = await q.one(`SELECT * FROM bookings WHERE no = $1
      AND client_id IN (SELECT id FROM clients WHERE id = $2 OR merged_into = $2)`, [bookingNo, clientId]);
    if (!b) throw new DomainError('booking_not_found');
    if (b.status !== 'booked' || b.expires_at <= at) throw new DomainError('booking_not_active');
    const recent = await q.one(`SELECT id FROM events WHERE type = 'booking.extend_requested' AND booking_id = $1 AND at > $2 LIMIT 1`,
      [b.id, new Date(at.getTime() - DEDUPE_MS)]);
    const res = { requested: true, bookingNo: b.no, apartmentNo: b.apartment_no, until: iso(b.expires_at), repeated: Boolean(recent) };
    if (recent) return res;
    const ev = await emit(q, 'booking.extend_requested', { bookingId: b.id, apartmentNo: b.apartment_no, clientId: b.client_id },
      { hours }, actor, ctx);
    await notify(q, fx, ctx, { template: 'staff_extend_requested', audience: 'staff_group',
      vars: { bookingNo: b.no, apt: b.apartment_no, until: iso(b.expires_at), hoursText: hours ? ` (+${hours} ч)` : '' },
      eventId: ev, dedupeKey: `staff_extend_requested:${ev}` });
    return res;
  });
}
