// 15 §3.4: the core, payments and events take time only from clock.now() — never Date.now(), new Date() or SQL now().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', 'server');

const files = dir => !fs.existsSync(dir) ? [] : fs.readdirSync(dir, { recursive: true })
  .filter(f => f.endsWith('.js')).map(f => path.join(dir, f));

test('no system time outside clock.js', () => {
  const found = [];
  for (const f of ['core', 'payments', 'events'].flatMap(d => files(path.join(ROOT, d)))) {
    if (path.basename(f) === 'clock.js') continue;
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      if (/Date\.now\(|new Date\(\)/.test(code) || /['"`][^'"`]*\bnow\(\)[^'"`]*['"`]/.test(code)) found.push(`${path.relative(ROOT, f)}:${i + 1}`);
    });
  }
  assert.deepEqual(found, []);
});
