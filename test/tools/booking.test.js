// book_viewing on a temporary booking.json: saved, slot taken, sold refused, parallel writes kept, statuses untouched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FILES } from '../../server/tools/index.js';
import { parseTime } from '../../server/core/viewings.js';
import { list, start } from './helpers.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-booking-'));
const bookings = path.join(dir, 'booking.json');
const s = await start({ apartments: FILES.apartments, bookings });
after(() => s.server.close());
const saved = () => JSON.parse(fs.readFileSync(bookings, 'utf8'));
const free = list.find(a => a.status === 'free');
const sold = list.find(a => a.status === 'sold');
const day = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const req = (patch = {}) => ({ name: 'Askar', phone: '+998 90 123 45 67', datetime: `${day(3)}T15:00`, no: free.no, ...patch });
const apartmentsBefore = fs.readFileSync(FILES.apartments, 'utf8');

test('parseTime: Tashkent by default, offsets converted, junk refused', () => {
  assert.equal(parseTime('2026-10-25T15:00').local, '2026-10-25T15:00+05:00');
  assert.equal(parseTime('2026-10-25T10:00Z').local, '2026-10-25T15:00+05:00');
  // seconds are refused: otherwise 15:00:30 would slip past a booking at 15:00
  for (const bad of ['25.10.2026 15:00', '2026-10-25', '2026-13-45T99:00', '2026-10-25T15:00:30', 'завтра']) assert.equal(parseTime(bad), null, bad);
});

test('book_viewing: the booking lands in booking.json', async () => {
  const r = await s.call('book_viewing', req());
  assert.equal(r.isError, undefined, r.content?.[0]?.text);
  const b = r.structuredContent;
  assert.equal(b.datetime, `${day(3)}T15:00+05:00`);
  assert.deepEqual(saved(), [b]);
  assert.match(r.content[0].text, /Записано: Askar, квартира №\d+/);
});

test('book_viewing: the same apartment and time again → slot taken (also written with another offset)', async () => {
  const again = await s.call('book_viewing', req({ name: 'Other' }));
  assert.equal(again.isError, true);
  assert.match(again.content[0].text, /Это время занято/);
  const sameInstant = await s.call('book_viewing', req({ datetime: `${day(3)}T10:00Z` }));
  assert.equal(sameInstant.isError, true);
  assert.equal(saved().length, 1);
});

test('book_viewing: sold, unknown apartment, past time, bad phone or name → refused, nothing saved', async () => {
  const cases = [[{ no: sold.no }, /продана/], [{ no: 9999 }, /не найдена/], [{ datetime: `${day(-1)}T15:00` }, /в будущем/],
    [{ datetime: 'завтра в 3' }, /формате/], [{ phone: 'call me' }, /Телефон/], [{ name: 'A' }, /./]];
  for (const [patch, msg] of cases) {
    const r = await s.call('book_viewing', req({ ...patch, datetime: patch.datetime || `${day(4)}T11:00` }));
    assert.equal(r.isError, true, JSON.stringify(patch));
    assert.match(r.content[0].text, msg);
  }
  assert.equal(saved().length, 1);
});

test('book_viewing: 10 parallel bookings are all kept', async () => {
  const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => s.call('book_viewing', req({ datetime: `${day(5)}T${String(9 + i).padStart(2, '0')}:00` }))));
  assert.ok(rs.every(r => !r.isError));
  assert.equal(saved().length, 11);
  assert.equal(new Set(saved().map(b => b.id)).size, 11);
});

test('bookings never change apartments.json', () => {
  assert.equal(fs.readFileSync(FILES.apartments, 'utf8'), apartmentsBefore);
});
