// Read models of the admin clients screen (12 §5.1–5.2): the list with filters, the client card with bookings, payments, viewings,
// orders, dialogs and merges, the feed of one dialog, and the one write — showing the full phone number, which leaves a trace
// in the journal (NFR-PRIV-02). Lists carry masks only.
import { DomainError, need, staffIdOf } from './errors.js';
import { maskPhone } from './phone.js';
import { context, inTx } from './tx.js';
import { emit } from './events.js';
import { canonical } from './clients.js';
import { effectiveStatus } from './bookings.js';

const ROLES = ['manager', 'head'];
export const SCORES = ['hot', 'warm', 'cold'];

const encodeCursor = (key, tie) => Buffer.from(JSON.stringify([new Date(key).toISOString(), tie])).toString('base64url');
function decodeCursor(c) {
  if (c == null || c === '') return null;
  try {
    const [key, tie] = JSON.parse(Buffer.from(String(c), 'base64url').toString());
    if (Number.isNaN(new Date(key).getTime()) || typeof tie !== 'string') throw new Error('shape');
    return { key: new Date(key), tie };
  } catch {
    throw new DomainError('invalid_input', { fields: ['cursor'] });
  }
}
const pageSize = n => Math.min(200, Math.max(1, Number.isInteger(Number(n)) && Number(n) > 0 ? Number(n) : 50));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Search: digits (from 5) are a part of a phone, «@name» or text is a part of the Telegram name, text is a part of the name.
function searchSql(text, params) {
  const s = String(text ?? '').trim().slice(0, 60);
  if (!s) return '';
  const like = v => { params.push(`%${v.replace(/[\\%_]/g, m => '\\' + m)}%`); return `$${params.length}`; };
  const conds = [`c.name ILIKE ${like(s)}`, `c.telegram_username ILIKE ${like(s.replace(/^@/, ''))}`];
  const digits = s.replace(/[\s+()-]/g, '');
  if (/^\d{5,}$/.test(digits)) { params.push(`%${digits}%`); conds.push(`regexp_replace(c.phone, '\\D', '', 'g') LIKE $${params.length}`); }
  return ` AND (${conds.join(' OR ')})`;
}

const ACT = 'COALESCE(c.last_seen_at, c.created_at)';
const WAITING = `EXISTS (SELECT 1 FROM conversations v WHERE v.client_id = c.id AND v.kind = 'client' AND v.mode = 'human')`;
const ACTIVE = `EXISTS (SELECT 1 FROM bookings b WHERE b.client_id = c.id AND b.status IN ('held','booked') AND b.expires_at > $1)`;

const item = r => ({
  id: r.id, name: r.name, phone: maskPhone(r.phone), phoneVerified: r.phone_verified, telegramUsername: r.telegram_username,
  channels: r.channels, lang: r.lang, leadScore: r.lead_score, lastActiveAt: r.last_seen_at ?? r.created_at,
  assignee: r.staff_id ? { id: r.staff_id, name: r.staff_name } : null, waiting: r.waiting, hasActiveBooking: r.active
});

// opts-1: { score, mine, waiting, active, q, cursor, limit } → { items, next }, the latest activity first.
export async function clientsList(q, { score = null, mine = false, waiting = false, active = false, q: text = '', cursor = null, limit = 50 } = {}, actor, opts = {}) {
  need(actor, ...ROLES);
  const ctx = context(opts);
  const at = ctx.now();
  if (score != null && !SCORES.includes(score)) throw new DomainError('invalid_input', { fields: ['score'] });
  const params = [at];
  let where = 'c.merged_into IS NULL';
  if (score) { params.push(score); where += ` AND c.lead_score = $${params.length}`; }
  if (mine) { params.push(actor.id); where += ` AND c.assigned_staff_id = $${params.length}`; }
  if (waiting) where += ` AND ${WAITING}`;
  if (active) where += ` AND ${ACTIVE}`;
  where += searchSql(text, params);
  const cur = decodeCursor(cursor);
  if (cur) { params.push(cur.key, cur.tie); where += ` AND (${ACT}, c.id::text) < ($${params.length - 1}, $${params.length})`; }
  const n = pageSize(limit);
  const rows = await q.query(
    `SELECT c.*, ${ACT} AS act, s.id AS staff_id, s.name AS staff_name, ${WAITING} AS waiting, ${ACTIVE} AS active
       FROM clients c LEFT JOIN staff s ON s.id = c.assigned_staff_id
      WHERE ${where} ORDER BY ${ACT} DESC, c.id::text DESC LIMIT ${n + 1}`, params);
  const page = rows.slice(0, n);
  const last = page[page.length - 1];
  return { items: page.map(item), next: rows.length > n ? encodeCursor(last.act, last.id) : null };
}

const phoneOf = c => ({ phone: maskPhone(c.phone), hasPhone: c.phone != null, phoneVerified: c.phone_verified });

// → null when there is no such client. A card that was merged into another answers with the card it became.
export async function clientCard(q, id, actor, opts = {}) {
  need(actor, ...ROLES);
  const ctx = context(opts);
  const at = ctx.now();
  if (!UUID.test(String(id))) return null;
  const c = await canonical(q, id);
  if (!c) return null;
  const staff = c.assigned_staff_id && await q.one('SELECT id, name FROM staff WHERE id = $1', [c.assigned_staff_id]);
  const bookings = await q.query(
    `SELECT b.*, a.rooms, a.floor FROM bookings b JOIN apartments a ON a.no = b.apartment_no WHERE b.client_id = $1 ORDER BY b.held_at DESC, b.no DESC LIMIT 50`, [c.id]);
  const payments = await q.query(
    `SELECT p.id, p.code, p.kind, p.provider, p.amount, p.status, p.card_brand, p.card_mask, p.created_at, b.no AS booking_no, o.no AS order_no
       FROM payments p LEFT JOIN bookings b ON b.id = p.booking_id LEFT JOIN orders o ON o.id = p.order_id
      WHERE p.client_id = $1 ORDER BY p.created_at DESC, p.id DESC LIMIT 50`, [c.id]);
  const viewings = await q.query('SELECT id, apartment_no, at, status, channel FROM viewings WHERE client_id = $1 ORDER BY at DESC LIMIT 50', [c.id]);
  const orders = await q.query('SELECT no, kind, stage, estimate, apartment_no, created_at FROM orders WHERE client_id = $1 ORDER BY created_at DESC LIMIT 50', [c.id]);
  const dialogs = await q.query(
    `SELECT id, channel, lang, mode, message_count, created_at, last_message_at FROM conversations
      WHERE client_id = $1 AND kind = 'client' ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT 50`, [c.id]);
  const merges = await q.query(
    `SELECT e.at, e.data, l.first_channel AS from_channel FROM events e LEFT JOIN clients l ON l.id::text = e.data->>'from'
      WHERE e.type = 'client.merged' AND e.client_id = $1 ORDER BY e.at DESC, e.id DESC LIMIT 20`, [c.id]);
  return {
    client: {
      id: c.id, name: c.name, ...phoneOf(c), telegramUsername: c.telegram_username, telegramLinked: c.telegram_user_id != null,
      telegramBlocked: c.tg_blocked_at != null, lang: c.lang, channels: c.channels, firstChannel: c.first_channel,
      createdAt: c.created_at, lastSeenAt: c.last_seen_at, assignee: staff ? { id: staff.id, name: staff.name } : null,
      lead: c.lead_score ? { score: c.lead_score, summary: c.lead_summary, nextStep: c.lead_next_step, scoredAt: c.lead_scored_at } : null,
      possibleDuplicate: c.possible_duplicate_of != null, waiting: dialogs.some(d => d.mode === 'human')
    },
    bookings: bookings.map(b => ({ no: b.no, status: effectiveStatus(b, at), apartment: { no: b.apartment_no, rooms: b.rooms, floor: b.floor },
      deposit: Number(b.deposit_amount), heldAt: b.held_at, expiresAt: b.expires_at })),
    payments: payments.map(p => ({ id: p.id, code: p.code, kind: p.kind, provider: p.provider, amount: Number(p.amount), status: p.status,
      cardBrand: p.card_brand, cardMask: p.card_mask, createdAt: p.created_at, bookingNo: p.booking_no ?? null, orderNo: p.order_no ?? null })),
    viewings: viewings.map(v => ({ id: v.id, apartmentNo: v.apartment_no, at: v.at, status: v.status, channel: v.channel })),
    orders: orders.map(o => ({ no: o.no, kind: o.kind, stage: o.stage, estimate: o.estimate == null ? null : Number(o.estimate),
      apartmentNo: o.apartment_no, createdAt: o.created_at })),
    dialogs: dialogs.map(d => ({ id: d.id, channel: d.channel, lang: d.lang, mode: d.mode, messageCount: d.message_count,
      createdAt: d.created_at, lastMessageAt: d.last_message_at })),
    merges: merges.map(m => ({ at: m.at, rule: m.data?.rule ?? null, fromChannel: m.from_channel ?? null }))
  };
}

// The feed of one client dialog after the message `after` (12 §5.2): who said what, the blocks the person saw.
// → null when there is no such dialog (the dialogs of the analyst belong to the staff member and are not shown here).
export async function dialogFeed(q, id, { after = 0, limit = 200 } = {}, actor, opts = {}) {
  need(actor, ...ROLES);
  context(opts);
  if (!UUID.test(String(id))) return null;
  const conv = await q.one(`SELECT * FROM conversations WHERE id = $1 AND kind = 'client'`, [id]);
  if (!conv) return null;
  const from = Number.isInteger(Number(after)) && Number(after) > 0 ? Number(after) : 0;
  const rows = await q.query(
    'SELECT id, role, text, blocks, turn_id, created_at FROM messages WHERE conversation_id = $1 AND id > $2 ORDER BY id LIMIT $3', [id, from, pageSize(limit)]);
  return {
    conversation: { id: conv.id, clientId: conv.client_id, channel: conv.channel, lang: conv.lang, mode: conv.mode,
      messageCount: conv.message_count, createdAt: conv.created_at, lastMessageAt: conv.last_message_at },
    messages: rows.map(m => ({ id: Number(m.id), role: m.role, text: m.text, blocks: m.blocks ?? [], turnId: m.turn_id, createdAt: m.created_at }))
  };
}

// «Показать» (12 §5.2): the full number goes out once per press and the press goes to the journal without the number.
export async function revealPhone(db, clientId, actor, opts = {}) {
  need(actor, ...ROLES);
  const ctx = context(opts);
  return inTx(db, ctx, async q => {
    const c = UUID.test(String(clientId)) ? await canonical(q, clientId) : null;
    if (!c) throw new DomainError('not_found');
    await emit(q, 'client.phone_revealed', { clientId: c.id, staffId: staffIdOf(actor) }, {}, actor, ctx);
    return { phone: c.phone ?? null };
  });
}
