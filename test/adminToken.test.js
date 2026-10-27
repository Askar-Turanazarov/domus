// ADMIN_TOKEN is read once at start: each case runs the server in its own process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const server = new URL('../server.js', import.meta.url).href;
// Start the server with the given token, GET /api/orders with that token, print the status.
const statusWith = token => Number(execFileSync(process.execPath, ['--input-type=module', '-e', `
  const { default: app } = await import(${JSON.stringify(server)});
  const s = app.listen(0, async () => {
    const r = await fetch('http://127.0.0.1:' + s.address().port + '/api/orders', { headers: { Authorization: 'Bearer ' + process.env.ADMIN_TOKEN } });
    console.log(r.status); s.close();
  });`], { env: { ...process.env, ADMIN_TOKEN: token, ADMIN_PASSWORD_HASH: '', DATA_DIR: mkdtempSync(join(tmpdir(), 'fsp3d-')) }, encoding: 'utf8' }).trim());

test('a short or placeholder ADMIN_TOKEN keeps the manager API off (503)', () => {
  for (const weak of ['', '123', 'fifteen-chars-x', 'change-me-to-a-long-random-string', 'CHANGE-ME-please-1234567']) {
    assert.equal(statusWith(weak), 503, JSON.stringify(weak));
  }
});

test('a long random ADMIN_TOKEN works', () => {
  assert.equal(statusWith('0123456789abcdef'), 200);
  assert.equal(statusWith('9f2c4e6a8b0d1f3e5a7c9b1d3f5e7a9c'), 200);
});
