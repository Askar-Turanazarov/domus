// 06 §7: the Gemini day ends at midnight America/Los_Angeles (DST ends 01.11.2026); the guard skips a model
// one request before the minute's limit and after the day's.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pacificDayStart, nextPacificMidnight, tashkentDayStart, nextTashkentMidnight, createQuota } from '../../server/ai/quota.js';
import { createTestDb, resetDb } from '../support/db.js';

test('pacific day: PDT −7 before 01.11.2026, PST −8 after', () => {
  assert.equal(pacificDayStart(new Date('2026-10-28T10:00:00Z')).toISOString(), '2026-10-28T07:00:00.000Z');
  assert.equal(nextPacificMidnight(new Date('2026-10-28T10:00:00Z')).toISOString(), '2026-10-29T07:00:00.000Z');
  // the DST day: starts in PDT, the next midnight is PST
  assert.equal(pacificDayStart(new Date('2026-11-01T12:00:00Z')).toISOString(), '2026-11-01T07:00:00.000Z');
  assert.equal(nextPacificMidnight(new Date('2026-11-01T12:00:00Z')).toISOString(), '2026-11-02T08:00:00.000Z');
  assert.equal(pacificDayStart(new Date('2026-11-05T09:00:00Z')).toISOString(), '2026-11-05T08:00:00.000Z');
  // 13:00 Tashkent in November = the reset
  assert.equal(nextPacificMidnight(new Date('2026-11-05T07:59:00Z')).toISOString(), '2026-11-05T08:00:00.000Z');
});

test('tashkent day: UTC+5, no DST', () => {
  assert.equal(tashkentDayStart(new Date('2026-10-28T20:00:00Z')).toISOString(), '2026-10-28T19:00:00.000Z');
  assert.equal(nextTashkentMidnight(new Date('2026-10-28T18:59:00Z')).toISOString(), '2026-10-28T19:00:00.000Z');
});

let db;
before(async () => { db = await createTestDb(); });
beforeEach(async () => { await resetDb(db); });
after(async () => { await db.close?.(); });

const call = (at, model = 'gemini-3.8-flash') => db.query(
  "INSERT INTO ai_calls (at, provider, model, kind, ok) VALUES ($1, 'gemini', $2, 'chat', true)", [at, model]);

test('guard: 14 of 15 in the minute → skip till the oldest is a minute old', async () => {
  const t = new Date('2026-10-28T10:00:00Z');
  const quota = createQuota({ db, now: () => t });
  for (let i = 0; i < 13; i++) await call(new Date(t.getTime() - 50_000 + i * 1000));
  assert.equal(await quota.guard('gemini-3.8-flash'), null);
  await call(new Date(t.getTime() - 1000));
  const g = await quota.guard('gemini-3.8-flash');
  assert.equal(g.reason, 'quota_guard');
  assert.equal(g.until.toISOString(), new Date(t.getTime() + 10_000).toISOString());
  assert.equal(await quota.guard('gemini-3.6-flash'), null, 'per model');
  assert.equal(await quota.guard('claude-sonnet-5-5'), null, 'Claude has no free tier');
});

test('guard: the day used up → rate_day till the Pacific midnight; yesterday does not count', async () => {
  const t = new Date('2026-10-28T10:00:00Z');
  const quota = createQuota({ db, now: () => t });
  await db.query(`INSERT INTO ai_calls (at, provider, model, kind, ok)
    SELECT $1::timestamptz + (g * interval '1 second'), 'gemini', 'gemini-3.8-flash', 'chat', true FROM generate_series(1, 1500) g`,
  [new Date('2026-10-28T07:00:00Z')]);
  const g = await quota.guard('gemini-3.8-flash');
  assert.equal(g.reason, 'rate_day');
  assert.equal(g.until.toISOString(), '2026-10-29T07:00:00.000Z');
  const later = createQuota({ db, now: () => new Date('2026-10-29T07:30:00Z') });
  assert.equal(await later.guard('gemini-3.8-flash'), null);
});
