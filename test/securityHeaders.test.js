// 14 §7: the pages run under the CSP without 'unsafe-inline' for scripts, and vercel.json sends the same headers as the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CSP, STAFF_CSP, MINI_CSP, HEADERS, STAFF_HEADERS, COOP, noCoop, isStaff, STAFF_SOURCE, PUBLIC_SOURCE, COOP_SOURCE }
  from '../server/http/securityHeaders.js';

const root = path.join(import.meta.dirname, '..');
const pub = path.join(root, 'pages');
const pages = fs.readdirSync(pub).filter(f => f.endsWith('.html'));
const hashOf = s => `'sha256-${crypto.createHash('sha256').update(s).digest('base64')}'`;

test('no inline scripts in the pages except the import map, allowed by its hash', () => {
  assert.ok(pages.length >= 11, pages.join());
  for (const p of pages) {
    const html = fs.readFileSync(path.join(pub, p), 'utf8');
    for (const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
      if (/\ssrc=/.test(m[1])) continue;
      assert.match(m[1], /type="importmap"/, `${p}: an inline script — move it to /js/`);
      assert.ok(CSP.includes(hashOf(m[2])), `${p}: the import map changed — IMPORTMAP_HASH = ${hashOf(m[2])}`);
    }
    assert.doesNotMatch(html, /\son[a-z]+\s*=\s*["']/i, `${p}: an on*= handler`);
    assert.doesNotMatch(html, /href\s*=\s*["']\s*javascript:/i, `${p}: a javascript: link`);
  }
});

test('the CSP: no unsafe-inline / unsafe-eval for scripts; frames: staff never, public — the site and Telegram Web', () => {
  const dir = (csp, name) => csp.split('; ').find(d => d.startsWith(name + ' '));
  for (const csp of [CSP, STAFF_CSP, MINI_CSP]) {
    assert.doesNotMatch(dir(csp, 'script-src'), /unsafe/);
    assert.equal(dir(csp, 'object-src'), "object-src 'none'");
    assert.equal(dir(csp, 'base-uri'), "base-uri 'none'");
  }
  assert.equal(dir(CSP, 'frame-ancestors'), "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org");
  assert.equal(dir(STAFF_CSP, 'frame-ancestors'), "frame-ancestors 'none'");
  assert.doesNotMatch(dir(CSP, 'script-src'), /telegram/);
  assert.equal(STAFF_HEADERS['X-Frame-Options'], 'DENY');
  assert.equal(HEADERS['X-Frame-Options'], 'SAMEORIGIN');
  assert.match(dir(MINI_CSP, 'script-src'), / https:\/\/telegram\.org$/);
  assert.equal(dir(MINI_CSP, 'frame-ancestors'), 'frame-ancestors https://web.telegram.org https://*.telegram.org');
});

test('vercel.json sends the same headers as the server (the static files never reach Express)', () => {
  const v = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  const block = src => Object.fromEntries(v.headers.find(h => h.source === src).headers.map(h => [h.key, h.value]));
  assert.deepEqual(block(PUBLIC_SOURCE), HEADERS);
  assert.deepEqual(block(STAFF_SOURCE), STAFF_HEADERS);
  assert.deepEqual(block(COOP_SOURCE), { 'Cross-Origin-Opener-Policy': COOP });
  // the two blocks never meet and miss only /mini (its own headers in Express)
  const open = new RegExp('^' + PUBLIC_SOURCE + '$');
  const staff = ['/admin', '/admin/', '/admin/app.js', '/admin.html', '/dashboard', '/dashboard/', '/bookings.html', '/calls.html', '/api/catalog'];
  const others = ['/', '/ru', '/en/planner', '/index.html', '/building.html', '/b/abc', '/pay/card/1', '/print.html', '/js/i18n.js'];
  for (const p of staff) assert.ok(isStaff(p) && !open.test(p), p);
  for (const p of others) assert.ok(!isStaff(p) && open.test(p), p);
  assert.ok(!isStaff('/mini') && !open.test('/mini'));
  assert.ok(noCoop('/b/abc') && noCoop('/pay/card/1') && !noCoop('/') && !noCoop('/admin/'));
});
