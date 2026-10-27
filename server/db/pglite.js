// PGlite (tests and local run without DATABASE_URL): Postgres in the process, with pgvector (01 §8).
// dir: 'memory://' — in memory; a folder — kept between runs (.pglite/). A dev dependency, so loaded lazily.
import { handle } from './handle.js';

export async function pgliteDb(dir) {
  const [{ PGlite }, { vector }] = await Promise.all([import('@electric-sql/pglite'), import('@electric-sql/pglite-pgvector')]);
  const pg = new PGlite(dir, { extensions: { vector }, parsers: { 20: Number, 1700: Number } });
  await pg.waitReady;
  const rows = c => async (text, params = []) => (await c.query(text, params)).rows;
  return handle('pglite', rows(pg), {
    exec: async sql => { await pg.exec(sql); },
    tx: fn => pg.transaction(t => fn(handle('pglite', rows(t), { exec: async sql => { await t.exec(sql); } }))),
    close: () => pg.close()
  });
}
