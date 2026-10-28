// The booking confirmation PDF (05 §10; FR-PAY-09, FR-TG-10): only after payment, one A4 page in the client's language,
// the font has every needed glyph, the Outbox row after «Бронь подтверждена», sendDocument at delivery, the personal link route.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import { PDFDocument } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { fakeClock } from '../../server/core/clock.js';
import { createHold, extend } from '../../server/core/bookings.js';
import { startPayment } from '../../server/core/payments.js';
import { deliver } from '../../server/core/outbox.js';
import { submitCard, confirmCard } from '../../server/payments/card.js';
import { bookingPdf, bookingPdfData, pdfFileName, fullTime } from '../../server/payments/pdf.js';
import { createSender } from '../../server/notify/telegramSender.js';
import { createRender } from '../../server/notify/render.js';
import { mountBookings } from '../../server/http/bookings.js';
import { bookingPath } from '../../server/core/links.js';
import { createTestDb, resetDb } from '../support/db.js';
import { makeStaff, asStaff } from '../support/factories.js';

const ENV = { LINK_SECRET: 'test-secret', PUBLIC_URL: 'https://domus.test' };
const WEB = { type: 'client', id: null, role: 'client', channel: 'web' };
const OPTS = { env: ENV, render: createRender(ENV) };
let db, server, base;

before(async () => {
  db = await createTestDb();
  const app = express();
  mountBookings(app, db, OPTS);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await db.close(); });
beforeEach(async () => { await resetDb(db); fakeClock.set('2026-10-28T14:00:00+05:00'); });
afterEach(() => fakeClock.reset());

async function hold(apartmentNo = 41) {
  return (await createHold(db, { apartmentNo, client: { name: 'Дилноза Рахимова', phone: '+998901234567' },
    consent: { version: '2026-10-27' }, channel: 'web' }, WEB, OPTS)).booking;
}
async function booked(apartmentNo = 41) {
  const b = await hold(apartmentNo);
  const { paymentId } = await startPayment(db, { target: { bookingId: b.id }, provider: 'card' }, WEB, OPTS);
  const { sms } = await submitCard(db, { paymentId, number: '9860 0000 0009 0001', expiry: '12/29' }, OPTS);
  await confirmCard(db, { paymentId, code: sms.code }, OPTS);
  return db.one('SELECT * FROM bookings WHERE id = $1', [b.id]);
}
const isPdf = bytes => Buffer.from(bytes).subarray(0, 5).toString() === '%PDF-';

test('the font has every glyph 05 §10.3 asks for (Cyrillic, ‘ ʻ № « » • ²)', () => {
  for (const w of ['Regular', 'Bold']) {
    const font = fontkit.create(fs.readFileSync(new URL(`../../assets/fonts/NotoSans-${w}.ttf`, import.meta.url)));
    for (const ch of 'АЯабвёЁЎўҚқҒғҲҳ‘ʻ№«»•²—') assert.ok(font.hasGlyphForCodePoint(ch.codePointAt(0)), `${w}: ${ch}`);
  }
  assert.ok(fs.existsSync(new URL('../../assets/fonts/OFL.txt', import.meta.url)));
});

test('no PDF before the deposit is paid: pdf_unavailable', async () => {
  const b = await hold();
  await assert.rejects(bookingPdfData(db, b.id, { env: ENV }), e => e.code === 'pdf_unavailable');
});

test('a paid booking: one A4 page, the title in each language, the file name in Latin, the fonts as subsets', async () => {
  const b = await booked();
  for (const [lang, title] of [['ru', 'Подтверждение брони №'], ['uz', 'bron tasdiqnomasi'], ['en', 'Booking confirmation No.']]) {
    const pdf = await bookingPdf(db, b.id, { lang, env: ENV });
    assert.ok(isPdf(pdf.bytes), lang);
    assert.equal(pdf.filename, `Chinor-Park-bron-${b.no}.pdf`);
    assert.ok(pdf.bytes.length < 150_000, `${lang}: ${pdf.bytes.length} bytes — the subset did not work`);
    const doc = await PDFDocument.load(pdf.bytes);
    assert.equal(doc.getPageCount(), 1);
    assert.deepEqual(doc.getPage(0).getSize(), { width: 595.28, height: 841.89 });
    assert.ok(doc.getTitle().includes(title) && doc.getTitle().includes(String(b.no)), doc.getTitle());
  }
  assert.equal(pdfFileName(1042), 'Chinor-Park-bron-1042.pdf');
  assert.equal((await bookingPdf(db, b.id, { env: ENV })).lang, 'ru', 'no language asked → the client\'s');
});

test('the data are taken at generation: a prolonged booking shows its new end; the payment and the mask', async () => {
  const b = await booked();
  const d = await bookingPdfData(db, b.id, { env: ENV });
  assert.equal(d.status, 'booked');
  assert.equal(d.payment.provider, 'card');
  assert.match(d.payment.code, /^P-/);
  assert.equal(d.deposit, Number(b.deposit_amount));
  assert.equal(d.link, bookingPath(b, ENV));
  const manager = asStaff(await makeStaff(db));
  await extend(db, { bookingId: b.id, hours: 24, reason: 'просьба клиента', expectedVersion: b.version }, manager, OPTS);
  const later = await bookingPdfData(db, b.id, { env: ENV });
  assert.equal(later.expiresAt.getTime() - d.expiresAt.getTime(), 24 * 3600e3);
  fakeClock.set('2026-11-20T10:00:00+05:00');
  assert.equal((await bookingPdfData(db, b.id, { env: ENV })).status, 'expired', 'a closed booking still has its PDF');
  assert.equal(fullTime('2026-10-29T13:00:00Z', 'ru'), '29.10.2026, 18:00');
  assert.equal(fullTime('2026-10-29T13:00:00Z', 'en'), 'Oct 29, 2026, 6:00 PM');
});

test('Telegram: a send_document row after «Бронь подтверждена»; the file is built at delivery and goes by sendDocument', async () => {
  const b = await hold();
  await db.query('UPDATE clients SET telegram_chat_id = 555, lang = $2 WHERE id = $1', [b.client_id, 'uz']);
  const { paymentId } = await startPayment(db, { target: { bookingId: b.id }, provider: 'card' }, WEB, OPTS);
  const { sms } = await submitCard(db, { paymentId, number: '9860 0000 0009 0001', expiry: '12/29' }, OPTS);
  await confirmCard(db, { paymentId, code: sms.code }, OPTS);
  const rows = await db.query('SELECT * FROM outbox WHERE client_id = $1 AND template IN ($2, $3) ORDER BY id', [b.client_id, 'booking_confirmed', 'booking_pdf']);
  const own = rows.filter(r => r.template === 'booking_confirmed' ? r.vars.bookingNo === b.no : r.attachment.bookingId === b.id);
  assert.deepEqual(own.map(r => r.template), ['booking_confirmed', 'booking_pdf']);
  const row = own[1];
  assert.equal(row.op, 'send_document');
  assert.equal(row.dedupe_key, `pdf:${b.id}`);
  assert.deepEqual(row.attachment, { kind: 'booking_pdf', bookingId: b.id });
  assert.match(row.rendered.text, new RegExp(`№${b.no} bron tasdiqnomasi`));

  const sent = [];
  const api = { sendDocument: async (chat, file, other) => { sent.push({ chat, file, other }); return { message_id: 9 }; } };
  const document = r => bookingPdf(db, r.attachment.bookingId, { lang: r.lang, env: ENV });
  assert.equal((await deliver(db, [row.id], createSender({ api, document }))).sent, 1);
  assert.equal(sent.length, 1);
  assert.equal(Number(sent[0].chat), 555);
  assert.equal(sent[0].file.filename, `Chinor-Park-bron-${b.no}.pdf`);
  assert.match(sent[0].other.caption, /bron tasdiqnomasi/);
  // without a document builder the row is a bad request, not a retry loop
  const again = await db.one(`INSERT INTO outbox (created_at, audience, op, chat_id, client_id, template, lang, vars, rendered, attachment, status, next_attempt_at)
    VALUES ($1, 'client', 'send_document', 555, $2, 'booking_pdf', 'ru', '{}', $3, $4, 'pending', $1) RETURNING id`,
    [new Date('2026-10-28T09:00:00Z'), b.client_id, JSON.stringify(row.rendered), JSON.stringify(row.attachment)]);
  assert.equal((await deliver(db, [again.id], createSender({ api }))).failed, 1);
});

test('GET /b/:ref/confirmation.pdf: a wrong link 404, unpaid 404 pdf_unavailable, paid → the file, never cached', async () => {
  const held = await hold(43);
  const bad = await fetch(`${base}/b/${held.no}-${'x'.repeat(32)}/confirmation.pdf`);
  assert.equal(bad.status, 404);
  assert.equal((await bad.json()).error, 'link_invalid');
  const unpaid = await fetch(`${base}${bookingPath(held, ENV)}/confirmation.pdf`);
  assert.equal(unpaid.status, 404);
  assert.equal((await unpaid.json()).error, 'pdf_unavailable');

  const b = await booked(41);
  const res = await fetch(`${base}${bookingPath(b, ENV)}/confirmation.pdf?lang=en`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(res.headers.get('content-disposition'), `attachment; filename="Chinor-Park-bron-${b.no}.pdf"`);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
  const doc = await PDFDocument.load(new Uint8Array(await res.arrayBuffer()));
  assert.match(doc.getTitle(), /^Booking confirmation No\. /);
});
