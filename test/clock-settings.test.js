// The core clock and the settings (01 §10, §12; 02 §3.1).
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { now, fakeClock, toMs } from '../server/core/clock.js';
import { createSettings, validSetting, SettingError } from '../server/core/settings.js';
import { DEFAULT_SETTINGS } from '../server/core/defaults.js';
import { createTestDb, resetDb } from './support/db.js';

let db;
before(async () => { db = await createTestDb(); });
after(() => db.close());
afterEach(() => fakeClock.reset());

test('clock: system time by default; set / advance in tests; reset', () => {
  assert.ok(Math.abs(now() - Date.now()) < 1000);
  assert.equal(fakeClock.set('2026-10-28T10:00:00+05:00').toISOString(), '2026-10-28T05:00:00.000Z');
  assert.equal(fakeClock.advance('15m').toISOString(), '2026-10-28T05:15:00.000Z');
  fakeClock.advance('72h');
  assert.equal(now().toISOString(), '2026-10-31T05:15:00.000Z');
  const a = now(); a.setFullYear(2000);
  assert.equal(now().getFullYear(), 2026, 'now() returns a copy');
  assert.deepEqual(['30s', '2d', 500].map(toMs), [30e3, 1728e5, 500]);
  assert.throws(() => toMs('soon'));
  assert.throws(() => fakeClock.set('never'));
  fakeClock.reset();
  assert.ok(Math.abs(now() - Date.now()) < 1000);
});

test('settings: read from the base, cached 15 s by the clock, a change drops the cache', async () => {
  await resetDb(db);
  fakeClock.set('2026-10-28T10:00:00+05:00');
  const s = createSettings(db);
  assert.equal(await s.get('deposit_amount'), 10_000_000);
  assert.deepEqual((await s.get()).installment, DEFAULT_SETTINGS.installment);
  // changed in the base behind its back: the cache holds for 15 s
  await db.query("UPDATE settings SET value = '20' WHERE key = 'hold_minutes'");
  assert.equal(await s.get('hold_minutes'), 15);
  fakeClock.advance('14s');
  assert.equal(await s.get('hold_minutes'), 15);
  fakeClock.advance('1s');
  assert.equal(await s.get('hold_minutes'), 20);
  // set: saved, read back at once
  await s.set('booking_hours', 48, { type: 'system' });
  assert.equal(await s.get('booking_hours'), 48);
  assert.equal((await db.one("SELECT value FROM settings WHERE key = 'booking_hours'")).value, 48);
});

test('settings: a missing row falls back to the default; unknown keys in the base are ignored', async () => {
  await resetDb(db);
  await db.query("DELETE FROM settings WHERE key = 'max_active_bookings'");
  await db.query("INSERT INTO settings (key, value, updated_at) VALUES ('junk', '1', $1)", [new Date()]);
  const all = await createSettings(db).get();
  assert.equal(all.max_active_bookings, 2);
  assert.equal('junk' in all, false);
});

test('settings: the checks on save (02 §3.1)', async () => {
  const s = createSettings(db);
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) assert.ok(validSetting(k, v), k);
  const bad = [['deposit_amount', 999_000], ['deposit_amount', 10_000_500], ['hold_minutes', 4], ['booking_hours', 337],
    ['max_active_bookings', 0], ['installment', { minDownPct: 30, terms: [] }],
    ['installment', { minDownPct: 95, terms: [{ months: 12, markupPct: 0 }] }], ['furniture_prepay_pct', 5],
    ['reminders', { bookingHoursBefore: [49], viewingHoursBefore: 3 }], ['extend_max_hours', 169],
    ['chat_limits', { perMinute: 0, perDay: 1, perConversation: 1 }], ['offer_version', '27.10.2026'],
    ['ai', { geminiDisabled: 'no' }], ['nope', 1]];
  for (const [k, v] of bad) {
    assert.equal(validSetting(k, v), false, k);
    await assert.rejects(s.set(k, v), SettingError);
  }
});
