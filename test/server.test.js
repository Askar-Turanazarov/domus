// Server routes on a real server (port 0) over a PGlite base in memory.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pkg from '../package.json' with { type: 'json' };

process.env.ADMIN_TOKEN = 'server-test-token-123';
// The keys /api/health looks at: set empty here, so the author's local .env does not change what the test expects.
for (const k of ['QSTASH_TOKEN', 'TELEGRAM_BOT_TOKEN', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'CLICK_MODE', 'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY', 'VERCEL_GIT_COMMIT_SHA']) process.env[k] = '';
const { default: app } = await import('../server.js');
const server = app.listen(0);
after(() => server.close());
const base = () => `http://127.0.0.1:${server.address().port}`;
const auth = { Authorization: 'Bearer ' + process.env.ADMIN_TOKEN, 'Content-Type': 'application/json' };

test('PATCH /api/orders/:id: a non-numeric id is 404', async () => {
  for (const id of ['abc', '1x', '-1', '1.5']) {
    const res = await fetch(`${base()}/api/orders/${id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ status: 'done' }) });
    assert.equal(res.status, 404, id);
    assert.deepEqual(await res.json(), { error: 'not_found' });
  }
});

test('GET /api/health: statuses by 16 §6, not cached', async () => {
  const res = await fetch(`${base()}/api/health`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const h = await res.json();
  assert.match(h.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:00$/);
  assert.deepEqual({ ...h, time: 0 }, { status: 'ok', version: pkg.version, time: 0, db: 'ok', qstash: 'off', telegram: 'off',
    stripe: 'off', click: 'emulator', ai: { gemini: { status: 'off' }, anthropic: { status: 'off' } } });
});

test('security headers on pages, static files and the API', async () => {
  for (const url of ['/', '/building.html', '/js/i18n.js', '/api/catalog', '/api/nope', '/admin/']) {
    const h = (await fetch(base() + url)).headers;
    const staff = url.startsWith('/api/') || url.startsWith('/admin');
    assert.equal(h.get('x-content-type-options'), 'nosniff', url);
    assert.equal(h.get('x-frame-options'), staff ? 'DENY' : 'SAMEORIGIN', url);
    assert.match(h.get('content-security-policy'), staff ? /frame-ancestors 'none'/ : /frame-ancestors 'self' https:\/\/web\.telegram\.org/, url);
    assert.equal(h.get('referrer-policy'), 'strict-origin-when-cross-origin', url);
    assert.match(h.get('content-security-policy'), /^default-src 'self'; script-src 'self' 'sha256-/, url);
    assert.equal(h.get('permissions-policy'), 'camera=(), microphone=(), geolocation=(), payment=()', url);
    assert.equal(h.get('cross-origin-opener-policy'), 'same-origin', url);
  }
  // the booking page goes on to Stripe: no COOP there (14 §7)
  assert.equal((await fetch(base() + '/b/nope')).headers.get('cross-origin-opener-policy'), null);
});

test('unknown /api routes answer JSON 404; pages still work; templates by file name and unknown pages → the 404 page', async () => {
  for (const method of ['GET', 'POST']) {
    const res = await fetch(`${base()}/api/nope`, { method });
    assert.equal(res.status, 404, method);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await res.json(), { error: 'not_found' });
  }
  assert.equal((await fetch(`${base()}/api/catalog`)).status, 200);
  assert.equal((await fetch(`${base()}/`)).status, 200);
  for (const p of ['/building.html', '/booking.html', '/order.html', '/pay-card.html', '/admin/index.html', '/dashboard/index.html', '/admin.html', '/bookings.html', '/calls.html', '/nope']) {
    const r = await fetch(`${base()}${p}`);
    assert.equal(r.status, 404, p);
    assert.match(await r.text(), /404/);
  }
  for (const p of ['/index.html', '/print.html', '/admin/', '/dashboard/', '/ru/planner']) assert.equal((await fetch(`${base()}${p}`)).status, 200, p);
});
