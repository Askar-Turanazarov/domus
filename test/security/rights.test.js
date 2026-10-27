// Rights on every route (14 §3, 15 §6.2, NFR-SEC-03): the routes the app really has are listed in test/routes.json with an
// access label; a route missing there fails the test. Staff / Head / Bearer / Sig / Tg / Ref / Pay routes never answer an
// unauthenticated call with success; a manager gets 403 on Head routes; a change without X-Requested-With gets 403.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hashPassword } from '../../server/adminAuth.js';
import { createStaff } from '../../server/core/staff.js';

delete process.env.ADMIN_TOKEN;                        // the script token is another way in; this test is about sessions
const { default: app, db } = await import('../../server.js');
const { routes } = JSON.parse(readFileSync(new URL('../routes.json', import.meta.url), 'utf8'));

const LABELS = ['Pub', 'Dcl', 'Ref', 'Pay', 'Tg', 'Staff', 'Head', 'Bearer', 'Sig'];
const PASSWORD = 'rights test password';
let server, base, manager, head;

// What Express really has: [{ m, p }]. The /mcp `all` route lists every HTTP method → 'ALL'.
function actualRoutes() {
  const out = [];
  const walk = stack => {
    for (const l of stack) {
      if (l.route) {
        const ms = Object.keys(l.route.methods).filter(k => l.route.methods[k]).map(k => k.toUpperCase());
        for (const m of (ms.length > 20 ? ['ALL'] : ms)) out.push({ m, p: l.route.path });
      } else if (l.handle?.stack) walk(l.handle.stack);
    }
  };
  walk(app._router.stack);
  return out;
}
const key = r => `${r.m} ${r.p}`;

// /x/:id/(a|b) → a concrete path
const concrete = p => p.replace(/\/:\w+\(([^|)]+)[^)]*\)/g, '/$1').replace(/\/:\w+/g, '/x').replace(/\/\?$/, '') || '/';
const isRead = m => m === 'GET' || m === 'HEAD';

const login = async name => {
  const res = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'domus-admin' },
    body: JSON.stringify({ login: name, password: PASSWORD }) });
  assert.equal(res.status, 200);
  return res.headers.get('set-cookie').split(';')[0];
};

before(async () => {
  await db.ready?.();
  const passwordHash = await hashPassword(PASSWORD);
  await createStaff(db, { login: 'rights-manager', name: 'M', role: 'manager', passwordHash });
  await createStaff(db, { login: 'rights-head', name: 'H', role: 'head', passwordHash });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  manager = await login('rights-manager');
  head = await login('rights-head');
});
after(() => server.close());

test('every route of the app is in routes.json, and every listed route exists', () => {
  const have = new Set(actualRoutes().map(key)), listed = new Set(routes.map(key));
  assert.deepEqual([...have].filter(k => !listed.has(k)), [], 'routes without an access label: add them to test/routes.json');
  assert.deepEqual([...listed].filter(k => !have.has(k)), [], 'routes.json lists routes the app does not have');
  for (const r of routes) assert.ok(LABELS.includes(r.access), `${key(r)}: ${r.access}`);
});

test('without credentials, no protected route answers with success', async () => {
  const bad = [];
  for (const r of routes.filter(x => !['Pub', 'Dcl'].includes(x.access))) {
    const res = await fetch(base + concrete(r.p), { method: r.m === 'ALL' ? 'GET' : r.m,
      headers: { 'Content-Type': 'application/json' }, body: isRead(r.m) || r.m === 'ALL' ? undefined : '{}' });
    const allowed = r.unauth ?? [400, 401, 403, 404, 405, 503];
    if (!allowed.includes(res.status)) bad.push(`${key(r)} [${r.access}] → ${res.status}`);
    if (['Staff', 'Head'].includes(r.access) && res.status !== 401) bad.push(`${key(r)} [${r.access}] should be 401, got ${res.status}`);
    // the Click routes answer 200 with an error code in the body (05 §5.3)
    if (r.unauth?.includes(200) && !r.shell && res.status === 200) assert.ok((await res.json()).error < 0, `${key(r)} must carry a Click error code`);
  }
  assert.deepEqual(bad, []);
});

test('Head routes: no session → 401, a manager → 403, the head passes the gate', async () => {
  for (const r of routes.filter(x => x.access === 'Head')) {
    const call = cookie => fetch(base + concrete(r.p), { method: r.m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'domus-admin', ...(cookie ? { cookie } : {}) },
      body: isRead(r.m) ? undefined : '{}' });
    assert.equal((await call()).status, 401, key(r));
    assert.equal((await call(manager)).status, 403, key(r));
    assert.notEqual((await call(head)).status, 403, key(r));
  }
});

test('Staff routes: a signed-in manager is let in; a change without X-Requested-With → 403', async () => {
  for (const r of routes.filter(x => x.access === 'Staff')) {
    const res = await fetch(base + concrete(r.p), { method: r.m, headers: { cookie: manager, 'Content-Type': 'application/json' }, body: isRead(r.m) ? undefined : '{}' });
    if (!isRead(r.m)) assert.equal(res.status, 403, key(r));
    else assert.ok(![401, 403].includes(res.status), `${key(r)} → ${res.status}`);
  }
});

test('unknown paths under /api/admin and /api/dashboard are closed to a visitor (401, not 404)', async () => {
  for (const p of ['/api/admin/anything', '/api/admin/settings', '/api/dashboard/summary', '/api/dashboard/feed']) {
    assert.equal((await fetch(base + p)).status, 401, p);
    assert.equal((await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401, p);
  }
  assert.equal((await fetch(base + '/api/admin/anything', { headers: { cookie: manager } })).status, 404);   // signed in: an honest 404
});
