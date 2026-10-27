// Routes when the database is down: a JSON error, not a hanging request.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgres://u:p@127.0.0.1:1/none';   // nothing listens on port 1
const { default: app } = await import('../server.js');
const server = app.listen(0);
after(() => server.close());
const base = () => `http://127.0.0.1:${server.address().port}`;

test('GET /api/buildings/:id: the statuses database is down → 500 buildings_unavailable', async () => {
  const res = await fetch(`${base()}/api/buildings/novostroyka-12`, { signal: AbortSignal.timeout(20000) });
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'buildings_unavailable' });
});
