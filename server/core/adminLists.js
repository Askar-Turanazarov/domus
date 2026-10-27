// Read models of the admin (12 §4): the list of bookings with tabs, search and counts, the booking card, the list of payments
// with totals, the payment card. Reads only — extend / cancel / refund go through the core (bookings.js, refunds.js).
// Personal data leaves as masks (NFR-PRIV-02); card numbers do not exist here at all, only brand and mask (05 §4.2).
import { DomainError, need } from './errors.js';
import { maskPhone } from './phone.js';
import { context } from './tx.js';
import { effectiveStatus, settingsOf } from './bookings.js';
import { SOON_MS } from './adminViews.js';

const ROLES = ['manager', 'head'];
export const TABS = ['active', 'held', 'soon', 'closed'];
export const PAYMENT_STATUSES = ['pending', 'processing', 'succeeded', 'failed', 'cancelled', 'refund_due', 'refunded'];
export const PROVIDERS = ['card', 'click', 'stripe'];
const CLOSED = ['hold_expired', 'released', 'expired', 'cancelled', 'converted'];

// ---- cursor (13 §1.9): base64url of [sort key, tie-break] of the last row ----

const encodeCursor = (key, tie) => Buffer.from(JSON.stringify([new Date(key).toISOString(), tie])).toString('base64url');
function decodeCursor(c) {
  if (c == null || c === '') return null;
  try {
    const [key, tie] = JSON.parse(Buffer.from(String(c), 'base64url').toString());
    if (Number.isNaN(new Date(key).getTime()) || (typeof tie !== 'number' && typeof tie !== 'string')) throw new Error('shape');
    return { key: new Date(key), tie };
  } catch {
    throw new DomainError('invalid_input', { fields: ['cursor'] });
  }
}
const pageSize = n => Math.min(200, Math.max(1, Number.isInteger(Number(n)) && Number(n) > 0 ? Number(n) : 50));

// A date or a moment from the filter. A bare date is a day in Tashkent (+05:00); `to` as a bare date includes that day.
function momentOf(v, field, end = false) {
  if (v == null || v === '') return null;
  const s = String(v);
  const bare = /^\d{4}-\d{2}-\d{2}$/.test(s);
  const d = new Date(bare ? `${s}T00:00:00+05:00` : s);
  if (Number.isNaN(d.getTime())) throw new DomainError('invalid_input', { fields: [field] });
  return bare && end ? new Date(d.getTime() + 24 * 3600e3) : d;
}

const clientOf = (id, name, phone, tg) => ({ id, name, phone: maskPhone(phone), telegramLinked: tg != null });

// ---- bookings ----

// Search: a number is the booking or the apartment (and, from 5 digits, a part of a phone); text is a part of the name.
function searchSql(text, params) {
  const s = String(text ?? '').trim().slice(0, 60);
  if (!s) return '';
  const conds = [];
  const digits = s.replace(/[\s+()-]/g, '');
  if (/^\d+$/.test(digits)) {
    if (digits.length <= 9) { params.push(Number(digits)); conds.push(`b.no = $${params.length}`, `b.apartment_no = $${params.length}`); }
    if (digits.length >= 5) { params.push(`%${digits}%`); conds.push(`regexp_replace(c.phone, '\\D', '', 'g') LIKE $${params.length}`); }
  }
  params.push(`%${s.replace(/[\\%_]/g, m => '\\' + m)}%`);
  conds.push(`c.name ILIKE $${params.length}`);
  return ` AND (${conds.join(' OR ')})`;
}

// Where a tab starts (12 §4.1): «active» and «held» only while the deadline is ahead, otherwise the row is closed even if
// the sweep has not run yet (effectiveStatus).
function tabSql(tab) {
  switch (tab) {
    case 'active': return `b.status = 'booked' AND b.expires_at > $1`;
    case 'held': return `b.status = 'held' AND b.expires_at > $1`;
    case 'soon': return `b.status = 'booked' AND b.expires_at > $1 AND b.expires_at < $1::timestamptz + interval '24 hours'`;
    case 'closed': return `(b.status NOT IN ('held','booked') OR b.expires_at <= $1)`;
    default: throw new DomainError('invalid_input', { fields: ['tab'] });
  }
}

const FROM = `FROM bookings b JOIN clients c ON c.id = b.client_id JOIN apartments a ON a.no = b.apartment_no
  LEFT JOIN staff s ON s.id = c.assigned_staff_id
  LEFT JOIN LATERAL (SELECT p.code, p.provider, p.card_brand, p.status FROM payments p WHERE p.booking_id = b.id AND p.kind = 'deposit'
    ORDER BY (p.status IN ('succeeded','refund_due','refunded')) DESC, p.created_at DESC LIMIT 1) pay ON true`;

const bookingItem = (r, at) => {
  const status = effectiveStatus(r, at);
  return {
    no: r.no, status, channel: r.channel, heldAt: r.held_at, expiresAt: r.expires_at, closedAt: r.closed_at, version: r.version,
    soon: status === 'booked' && r.expires_at.getTime() - at.getTime() < SOON_MS,
    deposit: Number(r.deposit_amount),
    apartment: { no: r.apartment_no, rooms: r.a_rooms, floor: r.a_floor },
    client: clientOf(r.client_id, r.c_name, r.c_phone, r.c_tg),
    payment: r.pay_code ? { code: r.pay_code, provider: r.pay_provider, cardBrand: r.pay_brand, status: r.pay_status } : null,
    assignee: r.staff_name ?? null
  };
};
const COLS = `b.*, a.rooms AS a_rooms, a.floor AS a_floor, c.name AS c_name, c.phone AS c_phone, c.telegram_user_id AS c_tg,
  s.name AS staff_name, pay.code AS pay_code, pay.provider AS pay_provider, pay.card_brand AS pay_brand, pay.status AS pay_status`;

// opts-1: { tab, q, cursor, limit } → { items, next, counts: { active, held, soon } }, newest first by the start of the hold.
export async function bookingsList(q, { tab = 'active', q: text = '', cursor = null, limit = 50 } = {}, actor, opts = {}) {
  need(actor, ...ROLES);
  const { now } = context(opts);
  const at = now();
  if (!TABS.includes(tab)) throw new DomainError('invalid_input', { fields: ['tab'] });
  const params = [at];
  let sql = `SELECT ${COLS} ${FROM} WHERE ${tabSql(tab)}${searchSql(text, params)}`;
  const cur = decodeCursor(cursor);
  if (cur) { params.push(cur.key, cur.tie); sql += ` AND (b.held_at, b.no) < ($${params.length - 1}, $${params.length})`; }
  const n = pageSize(limit);
  const rows = await q.query(`${sql} ORDER BY b.held_at DESC, b.no DESC LIMIT ${n + 1}`, params);
  const page = rows.slice(0, n);
  const counts = await q.one(
    `SELECT count(*) FILTER (WHERE status = 'booked' AND expires_at > $1)::int AS active,
            count(*) FILTER (WHERE status = 'held' AND expires_at > $1)::int AS held,
            count(*) FILTER (WHERE status = 'booked' AND expires_at > $1 AND expires_at < $1::timestamptz + interval '24 hours')::int AS soon
       FROM bookings`, [at]);
  const last = page[page.length - 1];
  return {
    items: page.map(r => bookingItem(r, at)),
    next: rows.length > n ? encodeCursor(last.held_at, last.no) : null,
    counts: { active: counts.active, held: counts.held, soon: counts.soon }
  };
}

// What a payment row shows (05 §12): brand and mask of the card, never its number.
const paymentRow = (p, refund) => ({
  id: p.id, code: p.code, kind: p.kind, provider: p.provider, amount: Number(p.amount), status: p.status, failureReason: p.failure_reason,
  cardBrand: p.card_brand, cardMask: p.card_mask, createdAt: p.created_at, succeededAt: p.succeeded_at,
  bookingNo: p.booking_no ?? null, orderNo: p.order_no ?? null,
  refund: refund ? { id: refund.id, status: refund.status, reason: refund.reason, failure: refund.failure } : null
});

// The deposit may come back by hand only when the booking closed without it coming back by the rules (03 §7.3).
export const refundableByHand = (p, b) => p.kind === 'deposit' && p.status === 'succeeded'
  && !!b && (b.status === 'expired' || (b.status === 'cancelled' && b.cancel_initiator === 'client'));

const eventShape = (e, noOf) => ({ id: Number(e.id), at: e.at, type: e.type, actor: e.actor?.type ?? 'system', staff: e.staff_name ?? null,
  bookingNo: noOf?.[e.booking_id] ?? null, data: e.data });

// → null when there is no booking with this number.
export async function bookingCard(q, no, actor, opts = {}) {
  need(actor, ...ROLES);
  const ctx = context(opts);
  const at = ctx.now();
  const r = await q.one(`SELECT ${COLS}, c.lang AS c_lang, a.price AS a_price, a.area AS a_area ${FROM} WHERE b.no = $1`, [no]);
  if (!r) return null;
  const status = effectiveStatus(r, at);
  const s = await settingsOf(q, ctx);
  const payments = await q.query(
    `SELECT p.*, r.id AS r_id, r.status AS r_status, r.reason AS r_reason, r.failure AS r_failure
       FROM payments p LEFT JOIN LATERAL (SELECT * FROM refunds WHERE payment_id = p.id ORDER BY created_at DESC LIMIT 1) r ON true
      WHERE p.booking_id = $1 ORDER BY p.created_at DESC`, [r.id]);
  const events = await q.query(
    `SELECT e.id, e.at, e.type, e.actor, e.booking_id, e.data, st.name AS staff_name
       FROM events e LEFT JOIN staff st ON st.id = e.staff_id WHERE e.booking_id = $1 ORDER BY e.at DESC, e.id DESC LIMIT 100`, [r.id]);
  const item = bookingItem(r, at);
  return {
    booking: {
      ...item, bookedAt: r.booked_at, price: Number(r.price_at_booking), consentAt: r.consent_at, extendedCount: r.extended_count,
      cancelInitiator: r.cancel_initiator, cancelReason: r.cancel_reason,
      canExtend: status === 'booked' && r.expires_at > at, canCancel: (status === 'booked' || status === 'held') && r.expires_at > at
    },
    apartment: { no: r.apartment_no, rooms: r.a_rooms, floor: r.a_floor, area: Number(r.a_area), price: Number(r.a_price) },
    limits: { extendMaxHours: s.extend_max_hours },
    payments: payments.map(p => ({
      ...paymentRow({ ...p, booking_no: r.no }, p.r_id && { id: p.r_id, status: p.r_status, reason: p.r_reason, failure: p.r_failure }),
      canRefund: refundableByHand(p, { status, cancel_initiator: r.cancel_initiator }) && !(p.r_status === 'pending' || p.r_status === 'succeeded')
    })),
    history: events.map(e => eventShape(e))
  };
}

// ---- payments ----

// opts-1: { provider, status, from, to, cursor, limit } → { items, next, totals: { count, succeededCount, succeededAmount } }.
// Totals are over the whole filter, not the page.
export async function paymentsList(q, { provider = null, status = null, from = null, to = null, cursor = null, limit = 50 } = {}, actor, opts = {}) {
  need(actor, ...ROLES);
  context(opts);
  if (provider != null && !PROVIDERS.includes(provider)) throw new DomainError('invalid_input', { fields: ['provider'] });
  if (status != null && !PAYMENT_STATUSES.includes(status)) throw new DomainError('invalid_input', { fields: ['status'] });
  const params = [];
  let where = 'TRUE';
  const add = (sql, v) => { params.push(v); where += ` AND ${sql.replace('?', '$' + params.length)}`; };
  if (provider) add('p.provider = ?', provider);
  if (status) add('p.status = ?', status);
  const [f, t] = [momentOf(from, 'from'), momentOf(to, 'to', true)];
  if (f) add('p.created_at >= ?', f);
  if (t) add('p.created_at < ?', t);
  const totals = await q.one(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE p.status = 'succeeded')::int AS ok,
            coalesce(sum(p.amount) FILTER (WHERE p.status = 'succeeded'), 0)::bigint AS sum FROM payments p WHERE ${where}`, params);
  const cur = decodeCursor(cursor);
  if (cur) { params.push(cur.key, String(cur.tie)); where += ` AND (p.created_at, p.id) < ($${params.length - 1}, $${params.length}::uuid)`; }
  const n = pageSize(limit);
  const rows = await q.query(
    `SELECT p.*, b.no AS booking_no, o.no AS order_no, c.name AS c_name, c.phone AS c_phone, c.telegram_user_id AS c_tg,
            r.id AS r_id, r.status AS r_status, r.reason AS r_reason, r.failure AS r_failure
       FROM payments p JOIN clients c ON c.id = p.client_id
       LEFT JOIN bookings b ON b.id = p.booking_id LEFT JOIN orders o ON o.id = p.order_id
       LEFT JOIN LATERAL (SELECT * FROM refunds WHERE payment_id = p.id ORDER BY created_at DESC LIMIT 1) r ON true
      WHERE ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT ${n + 1}`, params);
  const page = rows.slice(0, n);
  const last = page[page.length - 1];
  return {
    items: page.map(p => ({ ...paymentRow(p, p.r_id && { id: p.r_id, status: p.r_status, reason: p.r_reason, failure: p.r_failure }),
      client: clientOf(p.client_id, p.c_name, p.c_phone, p.c_tg) })),
    next: rows.length > n ? encodeCursor(last.created_at, last.id) : null,
    totals: { count: totals.n, succeededCount: totals.ok, succeededAmount: Number(totals.sum) }
  };
}

// The card of a payment (12 §4.2): attempts of the same booking or order, notifications of the provider (type, time, result —
// no bodies), all refunds. canRefund — the head may start a manual refund now (the core checks again); retryRefundId — the failed
// refund the head may repeat. → null when there is no such payment.
export async function paymentCard(q, id, actor, opts = {}) {
  need(actor, ...ROLES);
  const { now } = context(opts);
  const at = now();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id))) return null;
  const p = await q.one(
    `SELECT p.*, b.no AS booking_no, b.status AS b_status, b.expires_at AS b_expires_at, b.cancel_initiator AS b_initiator, o.no AS order_no,
            c.name AS c_name, c.phone AS c_phone, c.telegram_user_id AS c_tg
       FROM payments p JOIN clients c ON c.id = p.client_id LEFT JOIN bookings b ON b.id = p.booking_id LEFT JOIN orders o ON o.id = p.order_id
      WHERE p.id = $1`, [id]);
  if (!p) return null;
  const refunds = await q.query(
    `SELECT r.*, st.name AS staff_name FROM refunds r LEFT JOIN staff st ON st.id = NULLIF(r.requested_by->>'id', '')::uuid
      WHERE r.payment_id = $1 ORDER BY r.created_at DESC`, [id]);
  const attempts = await q.query(
    `SELECT code, provider, status, failure_reason, created_at FROM payments
      WHERE id <> $1 AND ((booking_id IS NOT NULL AND booking_id = $2) OR (order_id IS NOT NULL AND order_id = $3)) ORDER BY created_at DESC LIMIT 20`,
    [id, p.booking_id, p.order_id]);
  const events = await q.query(
    `SELECT type, received_at, result, provider FROM provider_events WHERE payment_id = $1 ORDER BY received_at DESC LIMIT 50`, [id]);
  const bStatus = p.b_status && effectiveStatus({ status: p.b_status, expires_at: p.b_expires_at }, at);
  const active = refunds.some(r => r.status === 'pending' || r.status === 'succeeded');
  const failed = refunds[0]?.status === 'failed' && !active ? refunds[0] : null;
  return {
    payment: { ...paymentRow(p, refunds[0]), client: clientOf(p.client_id, p.c_name, p.c_phone, p.c_tg), expiresAt: p.expires_at, currency: p.currency },
    canRefund: !active && refundableByHand(p, bStatus && { status: bStatus, cancel_initiator: p.b_initiator }),
    retryRefundId: p.status === 'refund_due' ? failed?.id ?? null : null,
    refunds: refunds.map(r => ({ id: r.id, status: r.status, reason: r.reason, note: r.note, failure: r.failure, amount: Number(r.amount),
      createdAt: r.created_at, completedAt: r.completed_at, by: r.requested_by?.type === 'staff' ? r.staff_name ?? 'staff' : r.requested_by?.type ?? 'system' })),
    attempts: attempts.map(a => ({ code: a.code, provider: a.provider, status: a.status, failureReason: a.failure_reason, createdAt: a.created_at })),
    providerEvents: events.map(e => ({ type: e.type, at: e.received_at, result: e.result, provider: e.provider }))
  };
}
