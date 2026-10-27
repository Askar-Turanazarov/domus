// Neon (production): a WebSocket Pool, one per function instance (01 §8). bigint/numeric come back as Number.
import { Pool, types } from '@neondatabase/serverless';
import { handle } from './handle.js';

types.setTypeParser(20, Number);     // int8
types.setTypeParser(1700, Number);   // numeric

export function neonDb(url, { max = 5 } = {}) {
  const pool = new Pool({ connectionString: url, max, idleTimeoutMillis: 10_000 });
  const rows = c => async (text, params = []) => (await c.query(text, params)).rows;
  return handle('neon', rows(pool), {
    exec: async sql => { await pool.query(sql); },
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const r = await fn(handle('neon', rows(c), { exec: async sql => { await c.query(sql); } }));
        await c.query('COMMIT');
        return r;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally { c.release(); }
    },
    close: () => pool.end()
  });
}
