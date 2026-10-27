// The database (D-17): Neon when DATABASE_URL is set, otherwise PGlite (tests, local run). No file storage.
// The handle is ready at once; the connection (and for PGlite — migrations and the base seed) starts on first use.
import path from 'node:path';
import { neonDb } from './neon.js';
import { pgliteDb } from './pglite.js';
import { migrate } from './migrate.js';
import { seedBase } from './seed/base.js';

const ROOT = path.join(import.meta.dirname, '..', '..');

// PGlite starts empty: bring it to the current schema and fill apartments and settings, so the local site works
// without any commands. Neon is migrated only by the author (npm run db:migrate) — a deploy never changes the base.
async function openPglite(dir) {
  const db = await pgliteDb(dir);
  await migrate(db);
  if (!(await db.one('SELECT 1 FROM apartments LIMIT 1'))) await seedBase(db);
  return db;
}

// url — DATABASE_URL; dir — PGLITE_DIR, default <project>/.pglite; under node --test always in memory (test files run in
// parallel and must never share or touch the local base).
export function createDb({ url = process.env.DATABASE_URL, dir = process.env.PGLITE_DIR } = {}) {
  if (url) { const db = neonDb(url); return Object.assign(db, { ready: async () => db }); }
  let ready;
  const get = () => (ready ??= openPglite(dir || (process.env.NODE_TEST_CONTEXT ? 'memory://' : path.join(ROOT, '.pglite'))));
  return {
    kind: 'pglite',
    query: async (t, p) => (await get()).query(t, p),
    one: async (t, p) => (await get()).one(t, p),
    exec: async sql => (await get()).exec(sql),
    tx: async fn => (await get()).tx(fn),
    ready: get,
    close: async () => { if (ready) await (await ready).close(); }
  };
}
