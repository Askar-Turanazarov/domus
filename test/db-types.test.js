// The adapter contract (01 §8, 02 §5): the same interface and the same JS types on PGlite and on Neon.
// Neon only with TEST_DATABASE_URL (a throwaway branch: the test migrates it and writes rows).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../server/db/index.js';
import { migrate } from '../server/db/migrate.js';

function contract(name, make, opts = {}) {
  let db;
  const open = async () => (db ??= await (async () => { const d = make(); await migrate(await d.ready()); return d; })());
  after(() => db?.close());

  test(`db (${name}): types — bigint and numeric as Number, timestamptz as Date, jsonb, text[]`, opts, async () => {
    const d = await open();
    const r = await d.one(`SELECT 10000000::bigint AS big, 48.6::numeric(6,1) AS num, $1::timestamptz AS at,
      '{"a":[1,2]}'::jsonb AS j, ARRAY['web','mcp']::text[] AS arr, gen_random_uuid() AS id`, [new Date('2026-10-27T10:00:00Z')]);
    assert.equal(r.big, 10000000);
    assert.equal(r.num, 48.6);
    assert.ok(r.at instanceof Date);
    assert.equal(r.at.toISOString(), '2026-10-27T10:00:00.000Z');
    assert.deepEqual(r.j, { a: [1, 2] });
    assert.deepEqual(r.arr, ['web', 'mcp']);
    assert.match(r.id, /^[0-9a-f-]{36}$/);
    assert.equal(await d.one('SELECT 1 WHERE false'), null);
  });

  test(`db (${name}): tx commits, rolls back on error, nested tx runs inside it`, opts, async () => {
    const d = await open();
    const key = 'test:' + Math.random();
    const put = (q, v) => q.query('INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3)', [key + v, JSON.stringify(v), new Date()]);
    await d.tx(async q => { await put(q, 1); await q.tx(q2 => put(q2, 2)); });
    await assert.rejects(d.tx(async q => { await put(q, 3); throw new Error('boom'); }), /boom/);
    const rows = await d.query('SELECT key FROM settings WHERE key LIKE $1 ORDER BY key', [key + '%']);
    assert.deepEqual(rows.map(r => r.key), [key + 1, key + 2]);
    await d.query('DELETE FROM settings WHERE key LIKE $1', [key + '%']);
  });
}

contract('pglite', () => createDb({ url: '', dir: 'memory://' }));
contract('neon', () => createDb({ url: process.env.TEST_DATABASE_URL }),
  { skip: !process.env.TEST_DATABASE_URL && 'TEST_DATABASE_URL is not set' });
