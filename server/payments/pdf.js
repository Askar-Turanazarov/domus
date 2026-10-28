// The booking confirmation PDF (05 §10, FR-PAY-09, FR-TG-10; D-07): pdf-lib + fontkit + qrcode, no Chromium. A4, one page,
// the client's language. Never stored: built from the base each time, so a prolonged booking shows its new end.
// The heavy modules are loaded on the first call and kept (01: lazy imports for the cold start).
import fs from 'node:fs';
import path from 'node:path';
import { DomainError } from '../core/errors.js';
import { now as clockNow } from '../core/clock.js';
import { effectiveStatus } from '../core/bookings.js';
import { maskPhone } from '../core/phone.js';
import { DEFAULT_SETTINGS } from '../core/defaults.js';
import { bookingPath } from '../core/links.js';
import { money, areaText } from '../notify/format.js';
import { t } from '../i18n/index.js';

const LANGS = ['ru', 'uz', 'en'];
const FONTS = path.join(import.meta.dirname, '..', '..', 'assets', 'fonts');
const TASHKENT_MS = 5 * 3600e3;
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = n => String(n).padStart(2, '0');

// «29.10.2026, 18:00» (ru, uz) / «Oct 29, 2026, 6:00 PM» (en), Tashkent time.
export function fullTime(at, lang) {
  const d = new Date(new Date(at).getTime() + TASHKENT_MS);
  const day = d.getUTCDate(), month = d.getUTCMonth(), year = d.getUTCFullYear(), h = d.getUTCHours(), m = d.getUTCMinutes();
  if (lang === 'en') return `${MONTHS_EN[month]} ${day}, ${year}, ${h % 12 || 12}:${two(m)} ${h < 12 ? 'AM' : 'PM'}`;
  return `${two(day)}.${two(month + 1)}.${year}, ${two(h)}:${two(m)}`;
}

// «Дилноза Рахимова» → «Дилноза Р.»: the paper may be forwarded, so only the first name and an initial.
const shortName = name => {
  const [first, second] = String(name ?? '').trim().split(/\s+/);
  return first ? (second ? `${first} ${second[0]}.` : first) : '—';
};

// The file name, Latin only (05 §10.2).
export const pdfFileName = no => `Chinor-Park-bron-${no}.pdf`;

// Everything the page shows, read in one go. → data | throws pdf_unavailable (the deposit was never paid).
export async function bookingPdfData(db, bookingId, { now = clockNow, env = process.env } = {}) {
  const b = await db.one('SELECT * FROM bookings WHERE id = $1', [bookingId]);
  if (!b?.booked_at) throw new DomainError('pdf_unavailable');
  const [c, apt, pay, row] = await Promise.all([
    db.one('SELECT name, phone, lang FROM clients WHERE id = $1', [b.client_id]),
    db.one('SELECT no, floor, rooms, area FROM apartments WHERE no = $1', [b.apartment_no]),
    db.one(`SELECT code, provider, card_brand, card_mask, succeeded_at FROM payments
             WHERE booking_id = $1 AND succeeded_at IS NOT NULL ORDER BY succeeded_at LIMIT 1`, [b.id]),
    db.one("SELECT value FROM settings WHERE key = 'bank_requisites'")
  ]);
  const at = now();
  return {
    no: b.no, status: effectiveStatus(b, at), expiresAt: b.expires_at, closedAt: b.closed_at,
    client: { name: c?.name, phone: c?.phone, lang: c?.lang }, apartment: apt,
    price: Number(b.price_at_booking), deposit: Number(b.deposit_amount), offerVersion: b.consent_version,
    payment: pay && { code: pay.code, provider: pay.provider, brand: pay.card_brand, mask: pay.card_mask, at: pay.succeeded_at },
    requisites: row?.value ?? DEFAULT_SETTINGS.bank_requisites,
    link: bookingPath(b, env), generatedAt: at
  };
}

// The status line of 05 §10.2: a live booking — until when; a closed one — what happened.
function statusLine(d, lang) {
  if (d.status === 'booked') return t(lang, 'pdf.status.booked', { until: fullTime(d.expiresAt, lang) });
  if (d.status === 'expired') return t(lang, 'pdf.status.expired', { at: fullTime(d.expiresAt, lang) });
  if (d.status === 'cancelled') return t(lang, 'pdf.status.cancelled', { at: fullTime(d.closedAt ?? d.generatedAt, lang) });
  return t(lang, `pdf.status.${d.status}`) ?? d.status;
}

function paidLine(p, lang) {
  if (!p) return '—';
  const card = p.mask ? `${p.brand ?? ''} •••• ${String(p.mask).slice(-4)}`.trim() : t(lang, `pdf.provider.${p.provider}`) ?? p.provider;
  return [fullTime(p.at, lang), card, p.code].join(' · ');
}

let libs;
async function load() {
  libs ??= (async () => {
    const [{ PDFDocument, rgb }, fontkit, qrcode, regular, bold] = await Promise.all([
      import('pdf-lib'), import('@pdf-lib/fontkit'), import('qrcode'),
      fs.promises.readFile(path.join(FONTS, 'NotoSans-Regular.ttf')), fs.promises.readFile(path.join(FONTS, 'NotoSans-Bold.ttf'))]);
    return { PDFDocument, rgb, fontkit: fontkit.default ?? fontkit, qr: qrcode.default ?? qrcode, regular, bold };
  })();
  return libs;
}

// Words into lines no wider than `width`.
function wrap(text, font, size, width) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(next, size) > width) { lines.push(line); line = word; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

// data (bookingPdfData), lang, base (the site address for the QR) → Uint8Array.
export async function renderBookingPdf(d, lang, { base = '' } = {}) {
  lang = LANGS.includes(lang) ? lang : 'ru';
  const { PDFDocument, rgb, fontkit, qr, regular, bold } = await load();
  const tr = (key, vars) => t(lang, `pdf.${key}`, vars);
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(tr('title', { no: d.no }));
  doc.setCreator('Domus Estate');
  doc.setProducer('Domus Estate');
  doc.setCreationDate(new Date(d.generatedAt));
  doc.setModificationDate(new Date(d.generatedAt));
  const font = await doc.embedFont(regular, { subset: true });
  const fontB = await doc.embedFont(bold, { subset: true });
  const page = doc.addPage([595.28, 841.89]);
  const ink = rgb(0.11, 0.1, 0.08), soft = rgb(0.42, 0.39, 0.34), gold = rgb(0.72, 0.53, 0.2);
  const L = 56, R = 595.28 - 56, W = R - L;
  let y = 841.89 - 64;
  const text = (s, x, size, f = font, color = ink) => page.drawText(String(s), { x, y, size, font: f, color });
  const para = (s, size = 10, indent = 0, f = font, color = ink) => {
    for (const line of wrap(s, f, size, W - indent)) { text(line, L + indent, size, f, color); y -= size * 1.45; }
  };

  // The header and the QR to the personal page (vector squares, 05 §10.3).
  const url = `${String(base).replace(/\/+$/, '')}${d.link}`;
  const m = qr.create(url, { errorCorrectionLevel: 'M' }).modules;
  const QR = 92, cell = QR / m.size, qx = R - QR, qy = y - QR + 14;
  for (let r = 0; r < m.size; r++) for (let c = 0; c < m.size; c++) {
    if (m.get(r, c)) page.drawRectangle({ x: qx + c * cell, y: qy + (m.size - 1 - r) * cell, width: cell + 0.01, height: cell + 0.01, color: ink });
  }
  text(tr('header'), L, 13, fontB); y -= 18;
  text(tr('training'), L, 9.5, font, soft); y -= 52;

  text(tr('title', { no: d.no }).toUpperCase(), L, 17, fontB); y -= 22;
  text(statusLine(d, lang), L, 11, font, d.status === 'booked' ? gold : soft); y -= 34;

  // The table: a caption on the left, the value on the right column.
  const a = d.apartment;
  const rows = [
    [tr('client'), `${shortName(d.client.name)}    ${maskPhone(d.client.phone)}`],
    [tr('apartment'), tr('aptLine', { no: a.no, rooms: a.rooms, floor: a.floor, area: areaText(a.area, lang) })],
    [tr('price'), `${money(d.price)} ${tr('sum')}`],
    [tr('deposit'), `${money(d.deposit)} ${tr('sum')}`],
    [tr('paid'), paidLine(d.payment, lang)]
  ];
  for (const [k, v] of rows) {
    text(k, L, 10.5, font, soft);
    text(v, L + 170, 10.5, k === tr('deposit') ? fontB : font);
    y -= 8;
    page.drawLine({ start: { x: L, y }, end: { x: R, y }, thickness: 0.4, color: rgb(0.85, 0.82, 0.76) });
    y -= 14;
  }
  y -= 14;

  text(tr('terms'), L, 12, fontB); y -= 18;
  for (const key of ['term1', 'term2']) {
    text('•', L, 10); para(tr(key), 10, 12); y -= 3;
  }
  text('•', L, 10); para(tr('term3', { version: d.offerVersion ?? DEFAULT_SETTINGS.offer_version }), 10, 12);
  y -= 16;

  const req = d.requisites;
  text(tr('requisites'), L, 12, fontB); y -= 18;
  for (const line of [req.name, `${tr('inn')} ${req.inn} · ${tr('account')} ${req.account}`, `${req.bank} · ${tr('mfo')} ${req.mfo}`,
    `${req.address} · ${req.phone}`]) para(line, 9.5, 0, font, soft);

  y = 72;
  text(tr('generated', { at: fullTime(d.generatedAt, lang) }), L, 9, font, soft); y -= 13;
  text(tr('notFiscal'), L, 9, font, soft);
  return doc.save();
}

// One call for the routes and the Telegram sender. → { bytes, filename, lang }.
export async function bookingPdf(db, bookingId, { lang, base, ...opts } = {}) {
  const d = await bookingPdfData(db, bookingId, opts);
  const l = LANGS.includes(lang) ? lang : d.client.lang;
  return { bytes: await renderBookingPdf(d, l, { base: base ?? opts.env?.PUBLIC_URL ?? process.env.PUBLIC_URL ?? '' }), filename: pdfFileName(d.no), lang: l };
}
