// Server routes on a real server (port 0) over a PGlite base in memory.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pkg from '../package.json' with { type: 'json' };

process.env.ADMIN_TOKEN = 'server-test-token-123';
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

test('GET /api/health: ok, base kind and version, not cached', async () => {
  const res = await fetch(`${base()}/api/health`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { ok: true, db: 'pglite', version: pkg.version });
});

test('security headers on pages, static files and the API', async () => {
  for (const url of ['/', '/building.html', '/js/i18n.js', '/api/catalog', '/api/nope']) {
    const h = (await fetch(base() + url)).headers;
    assert.equal(h.get('x-content-type-options'), 'nosniff', url);
    assert.equal(h.get('x-frame-options'), 'SAMEORIGIN', url);
    assert.equal(h.get('referrer-policy'), 'strict-origin-when-cross-origin', url);
  }
});

test('unknown /api routes answer JSON 404; pages still work', async () => {
  for (const method of ['GET', 'POST']) {
    const res = await fetch(`${base()}/api/nope`, { method });
    assert.equal(res.status, 404, method);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await res.json(), { error: 'not_found' });
  }
  assert.equal((await fetch(`${base()}/api/catalog`)).status, 200);
  assert.equal((await fetch(`${base()}/`)).status, 200);
  assert.equal((await fetch(`${base()}/building.html`)).status, 200);
});
