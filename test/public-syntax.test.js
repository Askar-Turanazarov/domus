// Every browser script parses (a lost backslash in a regex once broke the whole planner module on production).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const files = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? files(p) : p.endsWith('.js') ? [p] : [];
});

test('public/js, public/dashboard: node --check passes for each file', () => {
  const bad = [];
  for (const f of [...files('public/js'), ...files('public/dashboard')]) {
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { bad.push(`${f}: ${String(e.stderr).split('\n').find(l => /Error/.test(l))}`); }
  }
  assert.deepEqual(bad, []);
});
