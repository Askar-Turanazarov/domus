// BR-18 (03 §1): apartments, bookings and clients change only in server/core/. The HTTP entries, the payment layer, the
// bot and the tools call the core; a raw write to these tables anywhere else is a failure. The base itself (server/db:
// migrations, seed, the Domus store) is not an entry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', '..');
const SERVER = path.join(ROOT, 'server');
const WRITE = /\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+(apartments|bookings|clients)\b/i;

const files = dir => fs.readdirSync(dir, { recursive: true }).filter(f => f.endsWith('.js')).map(f => path.join(dir, f));

test('no write to apartments, bookings or clients outside server/core and server/db', () => {
  const found = [];
  for (const f of [...files(SERVER), path.join(ROOT, 'server.js')]) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    if (rel.startsWith('server/core/') || rel.startsWith('server/db/')) continue;
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (WRITE.test(line.replace(/\/\/.*$/, ''))) found.push(`${rel}:${i + 1}`);
    });
  }
  assert.deepEqual(found, []);
});

test('no status is changed by a PATCH any more (Domus: PATCH /api/buildings/:id/apartments/:apt is gone)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(!/app\.patch\(\s*['"`]\/api\/buildings/.test(src));
});
