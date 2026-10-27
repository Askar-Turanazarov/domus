// POST /api/bookings/by-ref/:ref/telegram-link (13 §4, 11 §6.1): a t.me link with a one-time code; limit 5 per hour; the same errors as any link.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fakeClock } from '../../server/core/clock.js';
import { attachTelegram } from '../../server/core/clients.js';
import { createTestDb, resetDb } from '../support/db.js';
import { startApi, ENV } from '../support/api.js';

let db, api, off;
const BOT_ENV = { ...ENV, TELEGRAM_BOT_TOKEN: '123456:TEST', TELEGRAM_BOT_USERNAME: '@chinorpark_dev_bot' };
const HOLD = { apartmentNo: 41, name: 'Аня', phone: '+998 90 123 45 67', consent: { version: '2026-10-27', privacy: true } };

before(async () => { db = await createTestDb(); api = await startApi(db, { env: BOT_ENV }); off = await startApi(db); });
after(async () => { api.close(); off.close(); await db.close(); });
beforeEach(async () => { await resetDb(db); fakeClock.set('2026-10-28T10:00:00+05:00'); });
afterEach(() => fakeClock.reset());

const hold = async () => (await api.call('POST', '/api/bookings/hold', HOLD)).body.link.replace('/b/', '');
const link = ref => api.call('POST', `/api/bookings/by-ref/${ref}/telegram-link`, {});

test('the link holds the code; /start with it joins the Telegram user to the booking client; page data says telegramLinked', async () => {
  const ref = await hold();
  const r = await link(ref);
  assert.equal(r.status, 200, r.text);
  const m = /^https:\/\/t\.me\/chinorpark_dev_bot\?start=lk_([A-Za-z0-9_-]{22})$/.exec(r.body.url);
  assert.ok(m, 'the leading @ of the username is dropped, the code is 16 bytes in base64url');
  assert.equal((await api.call('GET', `/api/bookings/by-ref/${ref}`)).body.telegramLinked, false);
  const stored = await db.one('SELECT * FROM client_link_codes');
  assert.notEqual(stored.code_hash, m[1], 'only the hash is stored');
  assert.equal(stored.code_hash, crypto.createHash('sha256').update(m[1]).digest('hex'));
  assert.equal(stored.expires_at.toISOString(), '2026-11-04T05:00:00.000Z', '7 days');

  await attachTelegram(db, { code: m[1], telegram: { userId: 77, chatId: 77 } });
  assert.equal((await api.call('GET', `/api/bookings/by-ref/${ref}`)).body.telegramLinked, true);
});

test('a bad or rotated link → link_invalid; 6th request in an hour → rate_limited; no bot configured → feature_disabled', async () => {
  assert.equal((await link('1001-' + 'x'.repeat(32))).body.error, 'link_invalid');
  const ref = await hold();
  for (let i = 0; i < 5; i++) assert.equal((await link(ref)).status, 200);
  const sixth = await link(ref);
  assert.deepEqual([sixth.status, sixth.body.error], [429, 'rate_limited']);
  fakeClock.advance('61m');
  assert.equal((await link(ref)).status, 200, 'the window has passed');

  const r = await off.call('POST', `/api/bookings/by-ref/${ref}/telegram-link`, {});
  assert.deepEqual([r.status, r.body.error], [503, 'feature_disabled']);
});
