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
import { mountAdmin } from './server/http/admin.js';
import { mountAdminBoard } from './server/http/adminBoard.js';
import { mountAdminBookings } from './server/http/adminBookings.js';
import { mountAdminClients } from './server/http/adminClients.js';
import { mountAdminOutbox } from './server/http/adminOutbox.js';
import { mountAdminAi } from './server/http/adminAi.js';
import { mountAdminSystem } from './server/http/adminSystem.js';
import { mountAdminDashboard } from './server/http/adminDashboard.js';
import * as pages from './server/pages.js';
import { loadEnv } from './server/env.js';
import { mountJobs, background } from './server/events/routes.js';
import { createNotify } from './server/notify/index.js';
import { mountPayments, mountStripeWebhook } from './server/http/payments.js';
import { mountBookings } from './server/http/bookings.js';
import { mountTelegram } from './server/telegram/webhook.js';
import { mountChat } from './server/http/chat.js';
import { createAi } from './server/ai/index.js';
import { createTools } from './server/tools/registry.js';
import { createKb } from './server/kb/retrieve.js';
import { createTurns } from './server/agents/turn.js';
import { createSettings } from './server/core/settings.js';
import { mountPersonalPages } from './server/http/personalPages.js';
import { requestId, noStore, apiErrors } from './server/http/common.js';
import { afterCommit } from './server/events/runner.js';

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

// What the core hands over after COMMIT (Outbox rows, jobs): delivered and published after the answer (03 §1 step 4).
// render writes the message into the Outbox row; send exists only with a bot token (without it rows wait in the Outbox window).
const notifyOpts = createNotify(process.env);
const coreOpts = { render: notifyOpts.render, onCommit: fx => background(afterCommit(db, fx, notifyOpts), 'after commit') };

// The consultant: the models (Gemini → Claude → scripts), the tools of the registry, the turn (07). One stack for the site chat.
const settings = createSettings(db);
const ai = createAi({ db, env: process.env, settings });
const kb = createKb({ db, ai, env: process.env });
const tools = createTools({ db, settings, env: process.env, kb });
const turns = createTurns({ db, ai, tools, env: process.env, settings, waitUntil: p => background(p, 'chat summary') });

app.set('trust proxy', 1);                 // the client's IP behind the Vercel / reverse proxy
// Basic security headers: no MIME sniffing, frames only from this site (the floor 3D iframe), short Referer.
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
  next();
});
app.use(requestId);
app.use('/api', noStore);
mountJobs(app, db, { ...notifyOpts });                      // deadlines: tick, /api/jobs/run (raw body for the QStash signature), /api/cron/daily
mountStripeWebhook(app, db, coreOpts);     // the raw body for the Stripe signature — before the JSON parser (05 §6.4)
mountTelegram(app, db, { core: coreOpts, turns, tools });  // Telegram webhook (10 §3): the secret, the answer at once, the bot in waitUntil
mountBookings(app, db, coreOpts);          // booking: hold, personal link (13 §4); own 64 KB JSON parser
mountChat(app, db, { turns, tools }, coreOpts);   // the site chat: POST /api/chat (SSE), confirm, feedback, messages (13 §6)
mountPayments(app, db, coreOpts);          // payments: start, emulators (05 §12); own 64 KB JSON parser
const staffAuth = mountAdmin(app, db, { env: process.env });   // /api/admin/login|logout|me and the gate on /api/admin/*, /api/dashboard/* (12 §2)
mountAdminBoard(app, db);                  // the chessboard and the apartment card (12 §3)
mountAdminBookings(app, db, staffAuth, coreOpts);   // bookings and payments: lists, cards, extend, cancel, refunds (12 §4)
mountAdminClients(app, db, staffAuth, coreOpts);    // clients, dialogs, the Telegram link of the staff member (12 §5, §12.3)
mountAdminOutbox(app, db, staffAuth, coreOpts);      // the Outbox window (12 §6)
mountAdminAi(app, db, staffAuth, { ...coreOpts, ai });   // AI journals, costs, the knowledge base (12 §8)
mountAdminSystem(app, db, staffAuth, { ...coreOpts, ai, settings });   // settings, services, AI providers (12 §10)
mountAdminDashboard(app, db, coreOpts);   // summary, charts and the live feed of the dashboard (12 §9)
mountPersonalPages(app, { publicDir: path.join(__dirname, 'public'), legalDir: path.join(__dirname, 'legal') });   // /b/…, /pay/card|click/…, /legal/…
app.use(express.json({ limit: '4mb' }));   // the order carries the drawing PNG and a 3D picture (≤ 1.5 MB each); Vercel takes ≤ 4.5 MB
app.use(express.static(path.join(__dirname, 'public'), { index: false }));   // "/" is rendered below
// The admin app (12 §1): a static shell; Vercel serves public/admin/ itself, the function only answers the bare /admin.
app.get('/admin', (req, res, next) => (req.originalUrl.split('?')[0] === '/admin' ? res.redirect(302, '/admin/') : next()));   // routing is not strict: "/admin/" matches too
app.get('/admin/', (req, res) => res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }).sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));
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

// The MCP server «chinor-park» (server/mcp/, 08 §7) on the site: POST /mcp with `Authorization: Bearer <token>`, the token
// decides the role (MCP_CLIENT_TOKEN — the demo client, MCP_HEAD_TOKEN — the head). No tokens in the environment — 503.
let mcp = null;
app.all('/mcp', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    mcp ||= import('./server/mcp/index.js').then(m => m.handleMcp);
    // req._body: express.json has read the body; otherwise the MCP code reads (and checks) it itself
    await (await mcp)(req, res, { db, tools, env: process.env, core: coreOpts, parsed: req._body ? req.body : undefined });
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
// Staff sign in with a login and password (server/http/admin.js, 12 §2) → the session cookie `dst`; scripts may still call
// these Domus routes with Authorization: Bearer ADMIN_TOKEN. They move under /api/admin/* with the new admin (13 §11).
// A short token or the .env.example placeholder counts as not set.
const weakToken = s => s.length < 16 || /^change-me/i.test(s);
const ADMIN_TOKEN = weakToken(process.env.ADMIN_TOKEN || '') ? '' : process.env.ADMIN_TOKEN;
const STATUSES = ['new', 'inWork', 'measure', 'done', 'cancelled'];

function bearerOk(req) {
  if (!ADMIN_TOKEN) return false;
  const got = Buffer.from(String(req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(ADMIN_TOKEN);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// Any signed-in staff member (the gate also asks X-Requested-With on changes) or the script token.
const admin = (req, res, next) => {
  if (bearerOk(req)) return next();
  res.set('Cache-Control', 'no-store');
  return staffAuth.gate()(req, res, next);
};

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
app.use(apiErrors);                        // a broken or too big body, an unexpected error: 13 §1.2 format

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) app.listen(PORT, () => console.log(`Domus: http://localhost:${PORT}`));

export { db };
export default app;
