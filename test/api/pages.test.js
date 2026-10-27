// D2-13: the pages behind a personal link keep to 03 §14 (no-store, noindex, no-referrer); the status map carries the
// terms of the hold form; the booking page data carries the terms of the booking.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeClock } from '../../server/core/clock.js';
import { mountPersonalPages } from '../../server/http/personalPages.js';
import { createTestDb, resetDb } from '../support/db.js';
import { startApi } from '../support/api.js';

const PUBLIC = path.join(import.meta.dirname, '..', '..', 'public');
let db, api, pages, base, legal;

before(async () => {
  db = await createTestDb();
  api = await startApi(db);
  legal = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-'));
  const app = express();
  mountPersonalPages(app, { publicDir: PUBLIC, legalDir: legal });
  pages = app.listen(0);
  base = `http://127.0.0.1:${pages.address().port}`;
});
after(async () => { api.close(); pages.close(); fs.rmSync(legal, { recursive: true, force: true }); await db.close(); });
beforeEach(async () => { await resetDb(db); fakeClock.set('2026-10-28T10:00:00+05:00'); });
afterEach(() => fakeClock.reset());

for (const url of ['/b/1042-abc', '/pay/card/3f2a1c9e-0000-4000-8000-000000000000', '/pay/click/3f2a1c9e-0000-4000-8000-000000000000']) {
  test(`${url.split('/').slice(0, 3).join('/')}…: no-store, noindex, no-referrer`, async () => {
    const r = await fetch(base + url);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.match(r.headers.get('x-robots-tag'), /noindex/);
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    const html = await r.text();
    assert.match(html, /<meta name="robots" content="noindex/);
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    assert.ok(inline.every(code => code.startsWith('try{document.documentElement.dataset.theme')), 'no inline script but the theme one');
  });
}

test('the page takes its <html lang> from ?lang=', async () => {
  const uz = await (await fetch(`${base}/b/1042-abc?lang=uz`)).text();
  assert.match(uz, /<html lang="uz">/);
  assert.match(await (await fetch(`${base}/b/1042-abc?lang=xx`)).text(), /<html lang="ru">/);
});

test('/legal/:doc: a stub in the language until the real file exists; the real file wins', async () => {
  const stub = await fetch(`${base}/legal/offer?lang=en`);
  assert.equal(stub.status, 200);
  assert.equal(stub.headers.get('cache-control'), 'public, max-age=3600');
  assert.match(await stub.text(), /Public offer/);
  fs.writeFileSync(path.join(legal, 'privacy.uz.html'), '<p>real policy</p>');
  assert.equal(await (await fetch(`${base}/legal/privacy?lang=uz`)).text(), '<p>real policy</p>');
  assert.equal((await fetch(`${base}/legal/other`)).status, 404);
});

test('GET /api/apartments/status: the map, the terms for the hold form, `mine` only for the holder', async () => {
  const empty = await api.call('GET', '/api/apartments/status');
  assert.equal(empty.status, 200);
  assert.equal(empty.body.statuses[41], 'free');
  assert.deepEqual(empty.body.terms, { offerVersion: '2026-10-27', depositAmount: 10_000_000, holdMinutes: 15, bookingHours: 72 });
  assert.equal(empty.body.mine, undefined);
  assert.equal(empty.body.at, '2026-10-28T10:00:00+05:00');

  const h = await api.call('POST', '/api/bookings/hold', { apartmentNo: 41, name: 'Аня', phone: '+998 90 123 45 67', consent: { version: '2026-10-27', privacy: true } });
  assert.equal(h.status, 201, h.text);
  const cookie = h.headers.get('set-cookie').split(';')[0];
  const mine = await api.call('GET', '/api/apartments/status', undefined, { headers: { cookie } });
  assert.equal(mine.body.statuses[41], 'held');
  assert.deepEqual(mine.body.mine[41], { link: h.body.link, expiresAt: h.body.expiresAt });
  const other = await api.call('GET', '/api/apartments/status');
  assert.equal(other.body.statuses[41], 'held');
  assert.equal(other.body.mine, undefined, 'a stranger sees the status but not the link');
  assert.ok(!JSON.stringify(other.body).includes(h.body.link));

  const page = await api.call('GET', `/api/bookings/by-ref/${h.body.link.replace('/b/', '')}`);
  assert.deepEqual(page.body.terms, { bookingHours: 72, holdMinutes: 15 });
});
