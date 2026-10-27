// TEMPORARY: the Domus storage interface over the new tables (02 §3), so the Domus pages, routes and MCP tools keep
// working until their new versions replace it — viewings and tools in D2/D3, orders and the journal in the admin (D4).
//   addOrder(order, files, ip) → no      orders + order_files, the name and phone go to clients
//   listOrders() → [order]               oldest first, in the Domus shape (id = order no, status as Domus names it)
//   updateOrder(no, fn) → order | null   fn(order) changes it in place
//   orderFile(no, name) → Buffer | null
//   statuses() → { [building]: { [no]: 'free' | 'booked' | 'sold' } }   computed from bookings (D-15), held → booked
//   allowOrder(ip) → bool                at most 5 orders per IP in 10 minutes
//   addBooking(b) → b | null             a viewing; null — that apartment and minute are taken
//   listBookings() → [viewing]           newest first
//   logCall(event)                       tool_calls (source mcp); a failed write is only reported
//   listCalls(limit) → [event]           newest first
import crypto from 'node:crypto';
import { normalizePhone } from '../core/phone.js';

const LIMIT = { max: 5, windowMs: 10 * 60 * 1000 };
const ipHash = ip => crypto.createHash('sha256').update('fsp3d:' + String(ip || '')).digest('hex').slice(0, 32);

// Domus order statuses ↔ order stages (02 §3.8).
const TO_STAGE = { new: 'new', inWork: 'in_work', measure: 'accepted', done: 'done', cancelled: 'cancelled' };
const FROM_STAGE = Object.fromEntries(Object.entries(TO_STAGE).map(([k, v]) => [v, k]));
// What lives in columns, not in the order document.
const OWN = ['id', 'createdAt', 'status', 'name', 'phone', 'files'];
const docOf = o => Object.fromEntries(Object.entries(o).filter(([k]) => !OWN.includes(k)));
const phoneOf = p => normalizePhone(p) ?? String(p ?? '').trim();
// 2026-10-29T05:00Z → '2026-10-29T10:00+05:00' (Tashkent, as Domus wrote it)
const tashkent = d => new Date(d.getTime() + 5 * 3600e3).toISOString().slice(0, 16) + '+05:00';

class Taken extends Error {}

export function legacyStore(db, { now = () => new Date() } = {}) {
  const newClient = (q, { name, phone }, channel) => q.one(
    `INSERT INTO clients (name, phone, first_channel, channels, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
    [name ?? null, phone ? phoneOf(phone) : null, channel, [channel], now()]);

  const orderOf = r => ({ id: r.no, createdAt: r.created_at.toISOString(), status: FROM_STAGE[r.stage] || r.stage,
    name: r.name, phone: r.phone, ...r.doc, ...(r.files?.length ? { files: r.files.map(f => `orders/${r.no}/${f}`) } : {}) });
  const ORDER = `SELECT o.no, o.created_at, o.stage, o.doc, c.name, c.phone,
      (SELECT array_agg(f.name ORDER BY f.name DESC) FROM order_files f WHERE f.order_id = o.id) AS files
    FROM orders o JOIN clients c ON c.id = o.client_id`;

  return {
    async addOrder(order, files, ip) {
      return db.tx(async q => {
        const c = await newClient(q, order, 'web');
        const ref = order.apartmentRef;
        const o = await q.one(
          `INSERT INTO orders (kind, client_id, apartment_no, stage, estimate, doc, ip_hash, lang, created_at, updated_at)
           VALUES ($1, $2, $3, 'new', $4, $5, $6, $7, $8, $8) RETURNING id, no`,
          [ref ? 'apartment_request' : 'furniture', c.id, ref?.apt ?? null, order.estimate == null ? null : Math.round(order.estimate),
            JSON.stringify(docOf(order)), ip == null ? null : ipHash(ip), order.lang || 'ru', now()]);
        for (const [name, buf] of files) await q.query('INSERT INTO order_files (order_id, name, data) VALUES ($1, $2, $3)', [o.id, name, buf]);
        return o.no;
      });
    },
    listOrders: async () => (await db.query(`${ORDER} ORDER BY o.no`)).map(orderOf),
    async updateOrder(no, fn) {
      return db.tx(async q => {
        const r = await q.one(`${ORDER} WHERE o.no = $1 FOR UPDATE OF o`, [no]);
        if (!r) return null;
        const o = orderOf(r);
        fn(o);
        await q.query('UPDATE orders SET stage = $1, doc = $2, updated_at = $3, version = version + 1 WHERE no = $4',
          [TO_STAGE[o.status] || 'new', JSON.stringify(docOf(o)), now(), no]);
        return o;
      });
    },
    async orderFile(no, name) {
      const r = await db.one('SELECT f.data FROM order_files f JOIN orders o ON o.id = f.order_id WHERE o.no = $1 AND f.name = $2', [no, name]);
      return r ? Buffer.from(r.data) : null;
    },
    async statuses() {
      const all = {};
      const rows = await db.query(`SELECT a.building, a.no,
          CASE WHEN a.sold_at IS NOT NULL THEN 'sold' WHEN b.status IS NOT NULL THEN 'booked' ELSE 'free' END AS status
        FROM apartments a
        LEFT JOIN bookings b ON b.apartment_no = a.no AND b.status IN ('held','booked') AND b.expires_at > $1`, [now()]);
      for (const r of rows) (all[r.building] ||= {})[r.no] = r.status;
      return all;
    },
    async allowOrder(ip) {
      const r = await db.one('SELECT count(*) AS n FROM orders WHERE ip_hash = $1 AND created_at > $2',
        [ipHash(ip), new Date(now().getTime() - LIMIT.windowMs)]);
      return r.n < LIMIT.max;
    },
    async addBooking(b) {
      try {
        return await db.tx(async q => {
          const c = await newClient(q, b, 'mcp');
          const v = await q.one(
            `INSERT INTO viewings (id, apartment_no, client_id, at, name, phone, status, channel, created_by, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'scheduled', 'mcp', '{"type":"mcp"}', $7, $7)
             ON CONFLICT (apartment_no, at) WHERE status = 'scheduled' DO NOTHING RETURNING id`,
            [b.id, b.no, c.id, new Date(Date.parse(b.datetime)), b.name, phoneOf(b.phone), new Date(b.createdAt)]);
          if (!v) throw new Taken();
          return b;
        });
      } catch (e) {
        if (e instanceof Taken) return null;
        throw e;
      }
    },
    async listBookings() {
      return (await db.query('SELECT id, apartment_no, name, phone, at, created_at FROM viewings ORDER BY created_at DESC, id'))
        .map(r => ({ id: r.id, no: r.apartment_no, name: r.name, phone: r.phone, datetime: tashkent(r.at), createdAt: r.created_at.toISOString() }));
    },
    // A refused request (no or wrong token) has no tool: its reason goes to error.
    async logCall(e) {
      try {
        await db.query('INSERT INTO tool_calls (at, source, tool, ok, error, ms, args) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [e.at ? new Date(e.at) : now(), 'mcp', e.type === 'denied' ? null : e.tool ?? null, !!e.ok,
            e.type === 'denied' ? e.reason : e.error ?? null, e.ms ?? null, e.args == null ? null : JSON.stringify(e.args)]);
      } catch (err) {
        console.error('call log write failed:', err.code || err.name);
      }
    },
    async listCalls(limit = 200) {
      return (await db.query('SELECT at, tool, ok, error, ms, args FROM tool_calls WHERE source = $1 ORDER BY at DESC, id DESC LIMIT $2', ['mcp', limit]))
        .map(r => r.tool == null
          ? { at: r.at.toISOString(), type: 'denied', reason: r.error }
          : { at: r.at.toISOString(), type: 'call', tool: r.tool, ok: r.ok, ms: r.ms, args: r.args, error: r.error ?? undefined });
    }
  };
}
