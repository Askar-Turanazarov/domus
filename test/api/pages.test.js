// D2-13: the pages behind a personal link keep to 03 §14 (no-store, noindex, no-referrer); the status map carries the
// terms of the hold form; the booking page data carries the terms of the booking. A wrong link or payment id → 404.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeClock } from '../../server/core/clock.js';
import { mountPersonalPages } from '../../server/http/personalPages.js';
import { createTestDb, resetDb } from '../support/db.js';
import { makeClient, makeBooking } from '../support/factories.js';
import { bookingPath } from '../../server/core/links.js';
import { now } from '../../server/core/clock.js';
import { startApi } from '../support/api.js';

const PAGES = path.join(import.meta.dirname, '..', '..', 'pages');
let db, api, pages, base, legal;

before(async () => {
  db = await createTestDb();
  api = await startApi(db);
  legal = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-'));
  const app = express();
  mountPersonalPages(app, { pagesDir: PAGES, legalDir: legal, db });
  pages = app.listen(0);
  base = `http://127.0.0.1:${pages.address().port}`;
});
after(async () => { api.close(); pages.close(); fs.rmSync(legal, { recursive: true, force: true }); await db.close(); });
beforeEach(async () => { await resetDb(db); fakeClock.set('2026-10-28T10:00:00+05:00'); });
afterEach(() => fakeClock.reset());

// A real booking link and real payments of the emulators (the pages open only for them).
async function realLinks() {
  const c = await makeClient(db);
  const b = await makeBooking(db, { clientId: c.id });
  const pay = provider => db.one(`INSERT INTO payments (code, kind, booking_id, client_id, provider, amount, status, created_by, created_at, updated_at)
    VALUES ($1, 'deposit', $2, $3, $4, 10000000, 'failed', '{"type":"client"}', $5, $5) RETURNING id`, [`P-${provider}`, b.id, c.id, provider, now()]);
  return { booking: bookingPath(b), card: `/pay/card/${(await pay('card')).id}`, click: `/pay/click/${(await pay('click')).id}` };
}

for (const kind of ['booking', 'card', 'click']) {
  test(`${kind} page: no-store, noindex, no-referrer`, async () => {
    const r = await fetch(base + (await realLinks())[kind]);
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
  const { booking } = await realLinks();
  const uz = await (await fetch(`${base}${booking}?lang=uz`)).text();
  assert.match(uz, /<html lang="uz">/);
  assert.match(await (await fetch(`${base}${booking}?lang=xx`)).text(), /<html lang="ru">/);
});

test('a wrong signature, an unknown number, a foreign provider or a made-up payment id → the 404 page', async () => {
  const { booking, card } = await realLinks();
  const bad = [booking.slice(0, -1) + (booking.endsWith('A') ? 'B' : 'A'), '/b/99999-' + 'A'.repeat(32), '/b/1042-abc', '/o/1-' + 'A'.repeat(32),
    '/pay/card/3f2a1c9e-0000-4000-8000-000000000000', '/pay/card/1', card.replace('/card/', '/click/')];
  for (const url of bad) {
    const r = await fetch(base + url);
    assert.equal(r.status, 404, url);
    assert.match(await r.text(), /Страница не найдена/);
  }
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
