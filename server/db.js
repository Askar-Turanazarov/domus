// Orders and apartment statuses: files on disk for local work (order.json, orders/<id>/, data/building-status.json),
// Postgres (Neon) when DATABASE_URL is set — on Vercel the functions have no disk that lasts.
// Both give the same interface:
//   addOrder(order, files) → id         files: [[name, Buffer]]; the order gets id, createdAt, status, files
//   listOrders() → [order]              oldest first
//   updateOrder(id, fn) → order | null  fn(order) changes it in place
//   orderFile(id, name) → Buffer | null
//   statuses() → { [building]: { [apt]: status } }
//   setStatus(building, apt, status)
//   allowOrder(ip) → bool               at most 5 orders per IP in 10 minutes
//   addBooking(b) → b | null            a viewing booking (server/core/viewings.js); null — that apartment and minute are taken
//   listBookings() → [booking]          newest first
//   logCall(event)                      the MCP call log; a failed write is only reported
//   listCalls(limit) → [event]          newest first, at most limit (200)
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createStore, createRateLimit } from './orderStore.js';
import { logEvent, readCalls, KEEP } from './callLog.js';
import { neon } from '@neondatabase/serverless';

const LIMIT = { max: 5, windowMs: 10 * 60 * 1000 };

function newOrder(id, order, files) {
  const o = { id, createdAt: new Date().toISOString(), status: 'new', ...order };
  if (files.length) o.files = files.map(([f]) => `orders/${id}/${f}`);
  return o;
}

// One write queue per file for the whole process: the site and the MCP tools share it.
const stores = new Map();
const storeFor = file => stores.get(file) || stores.set(file, createStore(file)).get(file);
const newestFirst = list => list.sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));

// Viewing bookings in booking.json. A broken file is an error, not an empty list.
function fileBookings(file) {
  return {
    addBooking: b => storeFor(file).update(list => {
      if (list.some(x => x.no === b.no && Date.parse(x.datetime) === Date.parse(b.datetime))) return null;
      list.push(b);
      return b;
    }),
    async listBookings() {
      let text;
      try { text = await fs.readFile(file, 'utf8'); } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
      }
      const list = JSON.parse(text);
      if (!Array.isArray(list)) throw new Error('bad_file');
      return newestFirst(list);
    }
  };
}

const fileCalls = file => ({ logCall: e => logEvent(file, e), listCalls: (limit = 200) => readCalls(file, limit) });

function fileDb({ ordersFile, filesDir, statusFile, bookingsFile, callsFile }) {
  const orders = createStore(ordersFile);
  const status = createStore(statusFile, () => ({}));
  const limit = createRateLimit(LIMIT);
  return {
    kind: 'files',
    addOrder: (order, files) => orders.update(async list => {
      let id = Date.now();
      while (list.some(o => o.id === id)) id++;
      if (files.length) {
        const dir = path.join(filesDir, String(id));
        await fs.mkdir(dir, { recursive: true });
        for (const [f, buf] of files) await fs.writeFile(path.join(dir, f), buf);
      }
      list.push(newOrder(id, order, files));
      return id;
    }),
    listOrders: () => orders.read(),
    updateOrder: (id, fn) => orders.update(list => {
      const o = list.find(x => x.id === id);
      if (o) fn(o);
      return o || null;
    }),
    orderFile: (id, name) => fs.readFile(path.join(filesDir, String(id), name)).catch(() => null),
    statuses: () => status.read(),
    setStatus: (b, apt, s) => status.update(all => { (all[b] ||= {})[apt] = s; }),
    allowOrder: async ip => limit(ip),
    ...fileBookings(bookingsFile),
    ...fileCalls(callsFile)
  };
}

// The schema is created on the first query of a function instance.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS orders (id bigint PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(),
     ip_hash text, rev integer NOT NULL DEFAULT 0, doc jsonb NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS orders_ip_time ON orders (ip_hash, created_at)',
  `CREATE TABLE IF NOT EXISTS order_files (order_id bigint NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
     name text NOT NULL, data bytea NOT NULL, PRIMARY KEY (order_id, name))`,
  `CREATE TABLE IF NOT EXISTS apt_status (building text NOT NULL, apt integer NOT NULL, status text NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (building, apt))`,
  // one booking per apartment and minute: the unique key decides, also between parallel functions
  `CREATE TABLE IF NOT EXISTS bookings (id uuid PRIMARY KEY, apt integer NOT NULL, at timestamptz NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(), doc jsonb NOT NULL, UNIQUE (apt, at))`,
  'CREATE TABLE IF NOT EXISTS mcp_calls (id bigserial PRIMARY KEY, at timestamptz NOT NULL, doc jsonb NOT NULL)',
  'CREATE INDEX IF NOT EXISTS mcp_calls_at ON mcp_calls (at)'
];

// sql(text, params) → rows. Neon's HTTP driver: one statement per request, no connection to keep.
// batch(texts) runs several statements in one request (the schema: one round trip per function instance, not four).
function pgDb(url, { query, batch } = {}) {
  if (!query) {
    const sql = neon(url);
    query = (text, params = []) => sql.query(text, params);
    batch = texts => sql.transaction(texts.map(t => sql.query(t)));
  }
  batch ||= async texts => { for (const t of texts) await query(t); };
  let ready = null;
  const q = async (text, params) => {
    ready ||= batch(SCHEMA).catch(e => { ready = null; throw e; });
    await ready;
    return query(text, params);
  };
  // The IP itself is not kept: a hash, enough to count the orders.
  const doc = r => (typeof r.doc === 'string' ? JSON.parse(r.doc) : r.doc);
  const ipHash = ip => crypto.createHash('sha256').update('fsp3d:' + String(ip || '')).digest('hex').slice(0, 32);

  return {
    kind: 'postgres',
    async addOrder(order, files, ip) {
      for (let id = Date.now(), tries = 0; tries < 50; id++, tries++) {
        const doc = newOrder(id, order, files);
        const rows = await q('INSERT INTO orders (id, created_at, ip_hash, doc) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING RETURNING id',
          [id, doc.createdAt, ip == null ? null : ipHash(ip), JSON.stringify(doc)]);
        if (!rows.length) continue;
        for (const [name, buf] of files) {
          await q('INSERT INTO order_files (order_id, name, data) VALUES ($1, $2, decode($3, \'base64\'))', [id, name, buf.toString('base64')]);
        }
        return id;
      }
      throw new Error('order_id');
    },
    async listOrders() {
      return (await q('SELECT doc FROM orders ORDER BY id')).map(r => (typeof r.doc === 'string' ? JSON.parse(r.doc) : r.doc));
    },
    // Read, change, write back if nobody changed it meanwhile (rev); else read again.
    async updateOrder(id, fn) {
      for (let tries = 0; tries < 10; tries++) {
        const [row] = await q('SELECT doc, rev FROM orders WHERE id = $1', [id]);
        if (!row) return null;
        const doc = typeof row.doc === 'string' ? JSON.parse(row.doc) : row.doc;
        fn(doc);
        const done = await q('UPDATE orders SET doc = $1, rev = rev + 1 WHERE id = $2 AND rev = $3 RETURNING id', [JSON.stringify(doc), id, row.rev]);
        if (done.length) return doc;
      }
      throw new Error('busy');
    },
    async orderFile(id, name) {
      const [row] = await q('SELECT encode(data, \'base64\') AS b64 FROM order_files WHERE order_id = $1 AND name = $2', [id, name]);
      return row ? Buffer.from(row.b64, 'base64') : null;
    },
    async statuses() {
      const all = {};
      for (const r of await q('SELECT building, apt, status FROM apt_status')) (all[r.building] ||= {})[r.apt] = r.status;
      return all;
    },
    async setStatus(b, apt, s) {
      await q(`INSERT INTO apt_status (building, apt, status) VALUES ($1, $2, $3)
        ON CONFLICT (building, apt) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`, [b, apt, s]);
    },
    async allowOrder(ip) {
      const [r] = await q('SELECT count(*)::int AS n FROM orders WHERE ip_hash = $1 AND created_at > now() - make_interval(secs => $2)',
        [ipHash(ip), LIMIT.windowMs / 1000]);
      return r.n < LIMIT.max;
    },
    async addBooking(b) {
      const rows = await q(`INSERT INTO bookings (id, apt, at, created_at, doc) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT DO NOTHING RETURNING id`, [b.id, b.no, new Date(Date.parse(b.datetime)).toISOString(), b.createdAt, JSON.stringify(b)]);
      return rows.length ? b : null;
    },
    async listBookings() {
      return (await q('SELECT doc FROM bookings ORDER BY created_at DESC')).map(doc);
    },
    // Like the file: the log keeps its last KEEP events (trimmed every 50th write), a failed write never breaks a tool.
    async logCall(event) {
      try {
        const e = { at: new Date().toISOString(), ...event };
        const [r] = await q('INSERT INTO mcp_calls (at, doc) VALUES ($1, $2) RETURNING id', [e.at, JSON.stringify(e)]);
        if (r && Number(r.id) % 50 === 0) await q('DELETE FROM mcp_calls WHERE id <= $1', [Number(r.id) - KEEP]);
      } catch (e) {
        console.error('call log write failed:', e.code || e.name);
      }
    },
    async listCalls(limit = 200) {
      return (await q('SELECT doc FROM mcp_calls ORDER BY at DESC, id DESC LIMIT $1', [limit])).map(doc);
    }
  };
}

/** The storage for this process: Postgres when DATABASE_URL is set, files otherwise. */
function createDb({ url = process.env.DATABASE_URL, root, dataDir } = {}) {
  if (url) return pgDb(url);
  return fileDb({
    ordersFile: path.join(root, 'order.json'),
    filesDir: path.join(root, 'orders'),
    statusFile: path.join(dataDir, 'building-status.json'),
    bookingsFile: process.env.BOOKING_FILE || path.join(root, 'booking.json'),
    callsFile: process.env.CALLS_FILE || path.join(root, 'mcp-calls.jsonl')
  });
}

export { createDb, fileDb, pgDb, fileBookings, fileCalls };
