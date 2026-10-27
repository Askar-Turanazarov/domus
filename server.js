import express from 'express';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { validateOrder } from './server/validateOrder.js';
import { createDb } from './server/db/index.js';
import { health } from './server/health.js';
import { legacyStore } from './server/db/legacy.js';
import { writeZip } from './server/zip.js';
import { fetchSet, libraryStatus, readLibMap } from './server/textureFetch.js';
import { BUILDING_ID, createBuildings } from './server/buildings.js';
import * as auth from './server/adminAuth.js';
import * as pages from './server/pages.js';
import { loadEnv } from './server/env.js';

const __dirname = import.meta.dirname;

loadEnv(__dirname);

const app = express();
const PORT = process.env.PORT || 3000;
const CATALOG = path.join(__dirname, 'catalog.json');
const TEMPLATES = path.join(__dirname, 'templates.json');
const APT_TEMPLATES = path.join(__dirname, 'apartment-templates.json');
const APARTMENTS = path.join(__dirname, 'apartments.json');   // the new-building apartments: rooms, area, price, status
// The base (server/db/): Neon with DATABASE_URL, PGlite otherwise. store — the Domus interface over it, until the
// new core replaces it (server/db/legacy.js).
const db = createDb();
const store = legacyStore(db);
const buildings = createBuildings(path.join(__dirname, 'buildings'), { read: () => store.statuses() }, APARTMENTS);

app.set('trust proxy', 1);                 // the client's IP behind the Vercel / reverse proxy
// Basic security headers: no MIME sniffing, frames only from this site (the floor 3D iframe), short Referer.
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
  next();
});
app.use(express.json({ limit: '4mb' }));   // the order carries the drawing PNG and a 3D picture (≤ 1.5 MB each); Vercel takes ≤ 4.5 MB
app.use(express.static(path.join(__dirname, 'public'), { index: false }));   // "/" is rendered below
app.get('/favicon.ico', (req, res) => res.redirect(301, '/favicon.svg'));
// Vercel serves public/ from its CDN but sends "/" to the function: the showcase from here (D-27; the planner is /:lang/planner/).
// The pages with the language in the address (and "/" = Russian): link previews (Open Graph) and the interface in that language.
const sendPage = (page, self) => (req, res) => {
  const ua = req.get('user-agent') || '';
  if (/bot|telegram|whatsapp|facebookexternalhit|preview/i.test(ua)) console.log('preview fetch', req.method, req.originalUrl, ua);   // which messengers come for the preview
  res.set('Cache-Control', 'public, max-age=0, s-maxage=3600').type('html')
    .send(pages.render(page, req.params.lang ?? 'ru', `${req.protocol}://${req.get('host')}`, self));
};
app.get('/', sendPage('building', pages.STATIC.building));
app.get('/:lang(ru|uz|en)/?', sendPage('building'));
app.get('/:lang(ru|uz|en)/building/?', sendPage('building'));   // the old Domus address, same page (its canonical is /:lang)
app.get('/:lang(ru|uz|en)/planner/?', sendPage('planner'));
// three.js from the package (on Vercel this runs in the function: let the CDN keep the files, the version is pinned)
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules', 'three'), {
  setHeaders: res => res.set('Cache-Control', 'public, max-age=604800, s-maxage=31536000')
}));

// Files of the deployment: the CDN may keep them (a new deployment starts with an empty cache).
const SHARED_JSON = 'public, max-age=0, s-maxage=600, stale-while-revalidate=86400';

// Statuses of the base and the services (server/health.js): 200 if the base is ok, else 503. No secrets.
const { version } = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
app.get('/api/health', async (req, res) => {
  const { code, body } = await health(db, { version });
  res.set('Cache-Control', 'no-store').status(code).json(body);
});

// The MCP server «Chinor Park» (server/mcp/) on the site: POST /mcp with `Authorization: Bearer <MCP_TOKEN>`.
// Bookings and the call log go to the site's storage, the tools see the manager's statuses. No MCP_TOKEN — off.
const MCP_MIN_TOKEN = 32;   // as server/mcp/index.js MIN_TOKEN
let mcp = null;
app.all('/mcp', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const token = process.env.MCP_TOKEN || '';
  if (token.length < MCP_MIN_TOKEN) return res.status(503).json({ error: 'mcp_disabled' });
  try {
    mcp ||= import('./server/mcp/index.js').then(m => ({ handle: m.handleMcp, ctx: m.dbContext(store) }));
    const { handle, ctx } = await mcp;
    // req._body: express.json has read the body; otherwise the MCP code reads (and checks) it itself
    await handle(req, res, { token, ctx, parsed: req._body ? req.body : undefined });
  } catch (e) {
    mcp = null;
    console.error('mcp request failed:', e.code || e.message);
    if (!res.headersSent) res.status(500).json({ error: 'internal' }); else res.destroy();
  }
});

app.get('/api/catalog', async (req, res) => {
  try {
    res.set('Cache-Control', SHARED_JSON).type('json').send(await fs.readFile(CATALOG, 'utf8'));
  } catch (e) {
    res.status(500).json({ error: 'catalog_unavailable' });
  }
});

app.get('/api/templates', async (req, res) => {
  try {
    res.set('Cache-Control', SHARED_JSON).type('json').send(await fs.readFile(TEMPLATES, 'utf8'));
  } catch (e) {
    res.status(500).json({ error: 'templates_unavailable' });
  }
});

app.get('/api/apartments', async (req, res) => {
  try {
    res.set('Cache-Control', SHARED_JSON).type('json').send(await fs.readFile(APT_TEMPLATES, 'utf8'));
  } catch (e) {
    res.status(500).json({ error: 'apartments_unavailable' });
  }
});

// ---------- new-building showcase: generated buildings (scripts/gen-building.mjs) + apartments.json + statuses by the manager ----------
app.get('/api/buildings', async (req, res) => {
  try {
    res.json(await buildings.list());
  } catch {
    res.status(500).json({ error: 'buildings_unavailable' });
  }
});

app.get('/api/buildings/:id', async (req, res) => {
  const t0 = Date.now();
  let b;
  try { b = await buildings.get(req.params.id); } catch { return res.status(500).json({ error: 'buildings_unavailable' }); }
  if (!b) return res.status(404).json({ error: 'not_found' });
  // Server-Timing: the building file + the statuses from the database (seen in the browser's network panel).
  res.set({ 'Cache-Control': 'no-cache', 'Server-Timing': `data;desc="${db.kind}";dur=${Date.now() - t0}` });
  res.json(b);
});

app.post('/api/order', async (req, res) => {
  const body = req.body || {};
  // Honeypot: people never see the "website" field; a filled one means a bot. Answer "ok", save nothing.
  if (body.website) return res.json({ ok: true, id: Date.now() });
  const v = validateOrder(body);
  if (!v.ok) return res.status(400).json({ error: v.error, field: v.field });
  // A request for a new-building apartment: it must exist; the manager sees its type, area and price.
  const ref = v.order.apartmentRef;
  if (ref) {
    const a = await buildings.apartment(ref.building, ref.apt);
    if (!a || a.floor !== ref.floor) return res.status(400).json({ error: 'invalid_order', field: 'apartmentRef' });
    v.order.apartment = { type: a.type, rooms: a.rooms, area: a.area, price: a.price, status: a.status };
    v.order.estimate ??= a.price;
  }
  try {
    if (!(await store.allowOrder(req.ip))) return res.status(429).json({ error: 'too_many' });
    // Drawing and 3D picture: plan.png, 3d.jpg next to the order (orders/<id>/ or the order_files table).
    const id = await store.addOrder(v.order, v.files, req.ip);
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: 'save_failed' });
  }
});

// ---------- manager: orders list, statuses, notes ----------
// The pages sign in with the manager password (ADMIN_PASSWORD_HASH, server/adminAuth.js) → a session cookie;
// scripts may still call the API with Authorization: Bearer ADMIN_TOKEN.
// A short token or the .env.example placeholder counts as not set.
const weakToken = s => s.length < 16 || /^change-me/i.test(s);
const ADMIN_TOKEN = weakToken(process.env.ADMIN_TOKEN || '') ? '' : process.env.ADMIN_TOKEN;
const ADMIN_HASH = auth.parseHash(process.env.ADMIN_PASSWORD_HASH) ? process.env.ADMIN_PASSWORD_HASH.trim() : '';
const STATUSES = ['new', 'inWork', 'measure', 'done', 'cancelled'];
// Failed sign-ins per IP: 5 in 15 minutes, then 429 until the oldest one ages out (one instance's memory on Vercel).
const LOGIN_FAILS = 5, LOGIN_WINDOW = 15 * 60 * 1000;
const loginFails = new Map();
const recentFails = ip => (loginFails.get(ip) || []).filter(t => Date.now() - t < LOGIN_WINDOW);
function failLogin(ip) {
  loginFails.set(ip, [...recentFails(ip), Date.now()]);
  if (loginFails.size > 10000) for (const k of loginFails.keys()) if (!recentFails(k).length) loginFails.delete(k);
}

function bearerOk(req) {
  if (!ADMIN_TOKEN) return false;
  const got = Buffer.from(String(req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(ADMIN_TOKEN);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const sessionOk = req => !!ADMIN_HASH && auth.validSession(auth.readCookie(req.get('cookie')), ADMIN_HASH);
// A change sent with the cookie from another site is refused (SameSite=Strict already stops it; this is the second lock).
function foreign(req) {
  const origin = req.get('origin');
  if (req.method === 'GET' || !origin) return false;
  try { return new URL(origin).host !== req.get('host'); } catch { return true; }   // "null" and junk count as foreign
}

function admin(req, res, next) {
  if (!ADMIN_TOKEN && !ADMIN_HASH) return res.status(503).json({ error: 'admin_disabled' });
  res.set('Cache-Control', 'no-store');
  if (bearerOk(req)) return next();
  if (!sessionOk(req)) return res.status(401).json({ error: 'unauthorized' });
  if (foreign(req)) return res.status(403).json({ error: 'forbidden' });
  next();
}

app.post('/api/admin/login', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!ADMIN_HASH) return res.status(503).json({ error: 'admin_disabled' });
  if (foreign(req)) return res.status(403).json({ error: 'forbidden' });
  if (recentFails(req.ip).length >= LOGIN_FAILS) return res.status(429).json({ error: 'too_many' });
  if (!(await auth.verifyPassword(req.body?.password, ADMIN_HASH))) {
    failLogin(req.ip);
    return res.status(401).json({ error: 'unauthorized' });
  }
  loginFails.delete(req.ip);
  res.set('Set-Cookie', auth.cookieHeader(auth.newSession(ADMIN_HASH), req.secure)).json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'Set-Cookie': auth.cookieHeader('', req.secure) }).json({ ok: true });
});

// Is this browser signed in? 200 / 401, or 503 when no password is set on the server.
app.get('/api/admin/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!ADMIN_HASH) return res.status(503).json({ error: 'admin_disabled' });
  res.status(sessionOk(req) ? 200 : 401).json({ ok: sessionOk(req) });
});

app.get('/api/orders', admin, async (req, res) => {
  try {
    const orders = await store.listOrders();
    res.json(orders.map(o => ({ status: 'new', ...o })).reverse());
  } catch {
    res.status(500).json({ error: 'read_failed' });
  }
});

app.patch('/api/orders/:id', admin, async (req, res) => {
  const id = Number(req.params.id), { status, note } = req.body || {};
  if (!/^\d{1,16}$/.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
  if (status !== undefined && !STATUSES.includes(status)) return res.status(400).json({ error: 'bad_status' });
  if (note !== undefined && (typeof note !== 'string' || note.length > 2000)) return res.status(400).json({ error: 'bad_note' });
  try {
    const order = await store.updateOrder(id, o => {
      const at = new Date().toISOString();
      if (status !== undefined && status !== (o.status || 'new')) {
        o.status = status;
        (o.history ||= []).push({ status, at });
      }
      if (note !== undefined) o.note = note;
      o.updatedAt = at;
    });
    if (!order) return res.status(404).json({ error: 'not_found' });
    res.json(order);
  } catch {
    res.status(500).json({ error: 'save_failed' });
  }
});

// Viewing bookings (written by the MCP tools), newest first; none yet = an empty list, a broken file = 500.
app.get('/api/bookings', admin, async (req, res) => {
  try {
    const list = await store.listBookings();
    res.json(list.map(({ id, createdAt, name, phone, no, datetime }) => ({ id, createdAt, name, phone, no, datetime }))
      .sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt))));
  } catch {
    res.status(500).json({ error: 'read_failed' });
  }
});

// The MCP call log: the last 200 events, newest first; none yet = an empty list.
app.get('/api/calls', admin, async (req, res) => {
  try {
    res.json(await store.listCalls(200));
  } catch {
    res.status(500).json({ error: 'read_failed' });
  }
});

// The drawing and the 3D picture of an order (fetched with the token, shown via a blob URL).
app.get('/api/orders/:id/:file', admin, async (req, res) => {
  const { id, file } = req.params;
  if (!/^\d{1,16}$/.test(id) || !['plan.png', '3d.jpg'].includes(file)) return res.status(404).end();
  try {
    const buf = await store.orderFile(Number(id), file);
    if (!buf) return res.status(404).end();
    res.type(file.endsWith('.png') ? 'png' : 'jpeg').send(buf);
  } catch {
    res.status(500).end();
  }
});

// ---------- photo textures: the built-in CC0 set (own photos stay in the visitor's browser) ----------
const TEXTURES = path.join(__dirname, 'public', 'textures');
const SETS = ['floor', 'wall', 'wood', 'fabric'];
const MAPS = ['color', 'normal', 'roughness'];

// The whole built-in set as a ZIP (stored, no compression: JPEGs are already compressed).
let packCache = null;
app.get('/api/textures/pack.zip', async (req, res) => {
  try {
    if (!packCache) {
      const files = [{ name: 'furniture-textures-cc0/README.md', data: await fs.readFile(path.join(TEXTURES, 'README.md')) }];
      for (const s of SETS) for (const m of MAPS) {
        files.push({ name: `furniture-textures-cc0/${s}/${m}.jpg`, data: await fs.readFile(path.join(TEXTURES, s, `${m}.jpg`)) });
      }
      packCache = writeZip(files);
    }
    res.attachment('furniture-textures-cc0.zip').type('zip').send(packCache);
  } catch {
    res.status(404).json({ error: 'pack_unavailable' });
  }
});

// Texture library: which sets are on disk; download a whitelisted set from ambientCG on demand.
app.get('/api/textures/library', async (req, res) => {
  try { res.json(await libraryStatus()); } catch { res.status(500).json({ error: 'library_failed' }); }
});

// A downloaded set's map that is not a static file (Vercel: it is in Blob). Same origin for the WebGL loaders;
// the CDN keeps it (s-maxage), so the function reads each file about once.
app.get('/textures/lib/:id/:file', async (req, res) => {
  const m = /^(\w+)\.jpg$/.exec(req.params.file);
  const buf = m && await readLibMap(String(req.params.id), m[1]).catch(() => null);
  // Missing: the CDN keeps the answer for a few minutes, so the pages do not ask the store each time.
  if (!buf) return res.set('Cache-Control', 'public, s-maxage=300').status(404).end();
  res.set('Cache-Control', 'public, max-age=86400, s-maxage=31536000, immutable').type('jpg').send(buf);
});

app.post('/api/textures/fetch/:id', async (req, res) => {
  try {
    await fetchSet(String(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    if (!e.status) console.error('texture set', req.params.id, 'failed:', e.message, e.cause?.message || '');
    const error = { 404: 'unknown_set', 429: 'busy', 503: 'store_unavailable' }[e.status] || 'download_failed';
    res.status(e.status || 502).json({ error });
  }
});

// Any other /api path: JSON, not the HTML "Cannot GET" page.
app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) app.listen(PORT, () => console.log(`Domus: http://localhost:${PORT}`));

export { db };
export default app;
