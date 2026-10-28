// Requests and furniture orders (03 §13, FR-FURN, S): a request for an apartment is a lead; a furniture order gets the
// 30% prepayment (BR-21) from its personal page /o/<no>-<sig> and then goes forward stage by stage (02 §3.8).
// The money side is the payment layer's (05 §3.3): it calls confirmPrepaid inside its own transaction.
import { DomainError, need, staffIdOf } from './errors.js';
import { emit } from './events.js';
import { maskPhone } from './phone.js';
import { context, inTx, notify } from './tx.js';
import { settingsOf } from './bookings.js';
import { resolveClient } from './clients.js';
import { closeOpenPayments } from './payments.js';
import { sign, parseRef, checkSig } from './links.js';
import { ipHash, docOf } from '../db/legacy.js';
import { failureText } from '../i18n/index.js';

export const STAGES = {
  furniture: ['new', 'accepted', 'production', 'delivery', 'assembly', 'done'],
  apartment_request: ['new', 'in_work', 'done']
};
const SYSTEM = { type: 'system', id: null, role: 'system', channel: 'system' };
const iso = d => (d ? new Date(d).toISOString() : null);

// orders have no access_version (02 §3.8): the signed line is 'order:<id>:1'.
export const orderPath = (o, env = process.env) => `/o/${o.no}-${sign('order', o.id, 1, env)}`;

// BR-21: round_to_1000(estimate × pct / 100); nothing to prepay for an order without an estimate.
export function prepayOf(estimate, pct) {
  const n = Math.round(Number(estimate) * Number(pct) / 100 / 1000) * 1000;
  return Number.isFinite(n) && n > 0 ? n : null;
}

const hasItems = order => [order, ...(order.rooms ?? [])].some(r => r?.items?.length);

// POST /api/order (03 §13): the client by the rules of §9, the order, its files, order.created; a request for an apartment
// goes to the staff group. order — validateOrder's output. → { id, no, kind, link | null }.
export async function createOrder(db, { order, files = [], ip = null }, opts = {}) {
  const ctx = context(opts);
  return inTx(db, ctx, async (q, fx) => {
    const at = ctx.now();
    const ref = order.apartmentRef ?? null;
    const kind = ref && !hasItems(order) ? 'apartment_request' : 'furniture';
    const c = await resolveClient(q, { name: order.name, phone: order.phone, lang: order.lang }, 'web', SYSTEM, ctx);
    const estimate = order.estimate == null ? null : Math.round(order.estimate);
    let bookingId = null, prepay = null;
    if (kind === 'furniture') {
      prepay = prepayOf(estimate, (await settingsOf(q, ctx)).furniture_prepay_pct);
      if (ref) {                                                                           // FR-FURN-01
        bookingId = (await q.one(`SELECT id FROM bookings WHERE client_id = $1 AND apartment_no = $2 AND status IN ('held','booked','converted')
          ORDER BY held_at DESC LIMIT 1`, [c.id, ref.apt]))?.id ?? null;
      }
    }
    const o = await q.one(`INSERT INTO orders (kind, client_id, booking_id, apartment_no, stage, estimate, prepay_amount, doc, ip_hash, lang,
        created_at, updated_at)
      VALUES ($1, $2, $3, $4, 'new', $5, $6, $7, $8, $9, $10, $10) RETURNING *`,
    [kind, c.id, bookingId, ref?.apt ?? null, estimate, prepay, JSON.stringify(docOf(order)), ip == null ? null : ipHash(ip), order.lang || 'ru', at]);
    for (const [name, buf] of files) await q.query('INSERT INTO order_files (order_id, name, data) VALUES ($1, $2, $3)', [o.id, name, buf]);
    const ev = await emit(q, 'order.created', { orderId: o.id, clientId: c.id, apartmentNo: o.apartment_no },
      { kind, ...(estimate != null && { estimate }) }, { type: 'client', id: c.id, role: 'client', channel: 'web' }, ctx);
    if (kind === 'apartment_request') {
      await notify(q, fx, ctx, { template: 'staff_new_request', audience: 'staff_group', clientId: c.id,
        vars: { apt: ref.apt, name: c.name ?? '', phoneMasked: maskPhone(c.phone) ?? '', comment: order.comment ?? '', clientId: c.id },
        eventId: ev, dedupeKey: `staff_new_request:${o.id}` });
    }
    return { id: o.id, no: o.no, kind, link: kind === 'furniture' && prepay ? orderPath(o, ctx.env) : null };
  });
}

// '/o/<ref>' → the order row; a wrong or old signature looks like no order at all (03 §14).
export async function orderByRef(q, ref, env = process.env) {
  const p = parseRef(ref);
  const o = p && await q.one(`SELECT * FROM orders WHERE no = $1 AND kind = 'furniture'`, [p.no]);
  if (!o || !checkSig('order', { id: o.id, access_version: 1 }, p.sig, env)) throw new DomainError('link_invalid');
  return o;
}

// What the order page shows (11 §6.6): the content without the name and phone, the money, the stage, the last payment.
export async function orderView(q, o, lang = 'ru', opts = {}) {
  const ctx = context(opts);
  const s = await settingsOf(q, ctx);
  const p = await q.one('SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1', [o.id]);
  const rooms = o.doc.rooms?.length ? o.doc.rooms : o.doc.items ? [{ name: o.doc.roomName, items: o.doc.items }] : [];
  return {
    order: { no: o.no, stage: o.stage, stages: STAGES.furniture, estimate: o.estimate == null ? null : Number(o.estimate),
      prepayAmount: o.prepay_amount == null ? null : Number(o.prepay_amount), prepaidAt: iso(o.prepaid_at), apartmentNo: o.apartment_no,
      consentVersion: o.consent_version, createdAt: iso(o.created_at), project: o.doc.project?.name ?? null,
      rooms: rooms.map(r => ({ name: r.name ?? null, items: (r.items ?? []).map(i => i.name ?? i.type ?? '').filter(Boolean) })) },
    payment: p ? { id: p.id, code: p.code, provider: p.provider, status: p.status, failureReason: p.failure_reason,
      failureText: failureText(p.failure_reason, lang), mask: p.card_mask, brand: p.card_brand } : null,
    offerVersion: s.offer_version, prepayPct: s.furniture_prepay_pct, serverNow: ctx.now().toISOString()
  };
}

// T (05 §3.3): the prepayment came, inside the payment layer's transaction. → 'prepaid' | 'duplicate' | 'late';
// the payment layer then sets the payment status and asks for the refund of a duplicate or a cancelled order's money.
export async function confirmPrepaid(q, fx, ctx, { orderId, payment }) {
  const at = ctx.now();
  const o = await q.one('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
  if (!o) throw new DomainError('order_not_found');
  if (o.prepaid_at) return 'duplicate';
  if (o.stage === 'cancelled') return 'late';
  const row = await q.one(`UPDATE orders SET prepaid_at = $2, stage = CASE WHEN stage = 'new' THEN 'accepted' ELSE stage END,
      updated_at = $2, version = version + 1 WHERE id = $1 RETURNING *`, [o.id, at]);
  const amount = Number(payment.amount);
  const ev = await emit(q, 'order.prepaid', { orderId: o.id, paymentId: payment.id, clientId: o.client_id, apartmentNo: o.apartment_no },
    { amount }, SYSTEM, ctx);
  await notify(q, fx, ctx, { template: 'order_prepaid', audience: 'client', clientId: o.client_id,
    vars: { amount, orderNo: o.no, link: orderPath(row, ctx.env) }, eventId: ev, dedupeKey: `order_prepaid:${o.id}` });
  await notify(q, fx, ctx, { template: 'staff_order_prepaid', audience: 'staff_group',
    vars: { amount, orderNo: o.no, apt: o.apartment_no ?? '—', clientId: o.client_id }, eventId: ev, dedupeKey: `staff_order_prepaid:${o.id}` });
  return 'prepaid';
}

// setStage (03 §13, FR-FURN-03): manager or head; only the next stage of the chain, or cancelled (not after done).
// An order with a prepayment becomes accepted when it is paid (confirmPrepaid); by hand before that — the head only (author, 28.10).
// The client hears of a furniture order's stage (order_stage_changed). → the order row.
export async function setStage(db, { orderId, stage, expectedVersion }, actor, opts = {}) {
  need(actor, 'manager', 'head');
  const ctx = context(opts);
  return inTx(db, ctx, async (q, fx) => {
    const at = ctx.now();
    const o = await q.one('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    if (!o) throw new DomainError('order_not_found');
    if (expectedVersion != null && Number(expectedVersion) !== o.version) throw new DomainError('stale');
    const chain = STAGES[o.kind];
    const next = chain[chain.indexOf(o.stage) + 1];
    const ok = stage === 'cancelled' ? !['done', 'cancelled'].includes(o.stage) : chain.includes(o.stage) && stage === next;
    if (!ok) throw new DomainError('stage_invalid');
    if (stage === 'accepted' && o.prepay_amount != null && !o.prepaid_at && actor.role !== 'head') throw new DomainError('prepay_required');
    const row = await q.one('UPDATE orders SET stage = $2, updated_at = $3, version = version + 1 WHERE id = $1 RETURNING *', [o.id, stage, at]);
    if (stage === 'cancelled') await closeOpenPayments(q, fx, ctx, { orderId: o.id, why: 'order_closed' });
    const ev = await emit(q, 'order.stage_changed', { orderId: o.id, clientId: o.client_id, staffId: staffIdOf(actor) },
      { from: o.stage, to: stage }, actor, ctx);
    if (o.kind === 'furniture') {
      await notify(q, fx, ctx, { template: 'order_stage_changed', audience: 'client', clientId: o.client_id,
        vars: { orderNo: o.no, stage, link: orderPath(row, ctx.env) }, eventId: ev, dedupeKey: `order_stage_changed:${o.id}:${row.version}` });
    }
    return row;
  });
}

const pageSize = n => Math.min(100, Math.max(1, Number.isInteger(Number(n)) && Number(n) > 0 ? Number(n) : 50));

// The admin list (12 §12.2): newest first; the client masked; the last payment of the prepayment. → { items, next }
export async function listOrders(q, { kind = null, stage = null, cursor = null, limit = 50 } = {}, actor) {
  need(actor, 'manager', 'head');
  const n = pageSize(limit);
  const before = cursor != null && /^\d{1,9}$/.test(String(cursor)) ? Number(cursor) : null;
  if (cursor != null && before == null) throw new DomainError('invalid_input', { fields: ['cursor'] });
  if (kind != null && !STAGES[kind]) throw new DomainError('invalid_input', { fields: ['kind'] });
  const rows = await q.query(`SELECT o.*, c.name AS c_name, c.phone AS c_phone, b.no AS booking_no,
      (SELECT row_to_json(p) FROM (SELECT status, code, provider FROM payments WHERE order_id = o.id ORDER BY created_at DESC LIMIT 1) p) AS pay,
      (SELECT array_agg(f.name ORDER BY f.name DESC) FROM order_files f WHERE f.order_id = o.id) AS files
    FROM orders o JOIN clients c ON c.id = o.client_id LEFT JOIN bookings b ON b.id = o.booking_id
    WHERE ($1::text IS NULL OR o.kind = $1) AND ($2::text IS NULL OR o.stage = $2) AND ($3::int IS NULL OR o.no < $3)
    ORDER BY o.no DESC LIMIT $4`, [kind, stage, before, n + 1]);
  const page = rows.slice(0, n);
  return { items: page.map(r => itemOf(r)), next: rows.length > n ? String(page.at(-1).no) : null };
}

const itemOf = r => ({
  id: r.id, no: r.no, kind: r.kind, stage: r.stage, version: r.version, clientId: r.client_id, name: r.c_name ?? null,
  phone: r.c_phone ? maskPhone(r.c_phone) : null, apartmentNo: r.apartment_no, bookingNo: r.booking_no ?? null,
  estimate: r.estimate == null ? null : Number(r.estimate), prepayAmount: r.prepay_amount == null ? null : Number(r.prepay_amount),
  prepaidAt: iso(r.prepaid_at), payment: r.pay ?? null, files: r.files ?? [], comment: r.doc?.comment ?? null, note: r.doc?.note ?? null,
  next: STAGES[r.kind][STAGES[r.kind].indexOf(r.stage) + 1] ?? null, createdAt: iso(r.created_at)
});

// One order for the admin (13 §11): the list item plus the document. id — the uuid or the number.
export async function getOrder(q, id, actor) {
  need(actor, 'manager', 'head');
  const by = /^\d{1,9}$/.test(String(id)) ? 'o.no = $1::int' : 'o.id = $1::uuid';
  if (by.startsWith('o.id') && !/^[0-9a-f-]{36}$/i.test(String(id))) throw new DomainError('order_not_found');
  const r = await q.one(`SELECT o.*, c.name AS c_name, c.phone AS c_phone, b.no AS booking_no,
      (SELECT row_to_json(p) FROM (SELECT status, code, provider FROM payments WHERE order_id = o.id ORDER BY created_at DESC LIMIT 1) p) AS pay,
      (SELECT array_agg(f.name ORDER BY f.name DESC) FROM order_files f WHERE f.order_id = o.id) AS files
    FROM orders o JOIN clients c ON c.id = o.client_id LEFT JOIN bookings b ON b.id = o.booking_id WHERE ${by}`, [String(id)]);
  if (!r) throw new DomainError('order_not_found');
  return { ...itemOf(r), doc: r.doc };
}
