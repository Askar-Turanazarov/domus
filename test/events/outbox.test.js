// Outbox (04 §3): recipients and skip reasons, dedupe (I7), the same transaction as the change, delivery outcomes.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock } from '../../server/core/clock.js';
import { enqueue, deliver, retryDue, classify } from '../../server/core/outbox.js';
import { emit } from '../../server/core/events.js';
import { createTestDb, resetDb } from '../support/db.js';

let db;
before(async () => { db = await createTestDb(); });
after(() => db.close());
beforeEach(async () => { await resetDb(db); fakeClock.set('2026-10-28T10:00:00+05:00'); });
afterEach(() => fakeClock.reset());

const ENV = { TELEGRAM_STAFF_CHAT_ID: '-100500' };
const render = (template, lang, vars) => ({ text: `${template}:${lang}:${vars.apt}` });
async function client({ chat = 777, lang = 'uz', blocked = null } = {}) {
  return (await db.one(`INSERT INTO clients (name, first_channel, telegram_chat_id, tg_blocked_at, lang, created_at, updated_at)
    VALUES ('Аня', 'web', $1, $2, $3, $4, $4) RETURNING id`, [chat, blocked, lang, new Date('2026-10-28T05:00:00Z')])).id;
}
const row = id => db.one('SELECT * FROM outbox WHERE id = $1', [id]);

test('enqueue: client in their language, rendered at once; no Telegram / blocked / no group → skipped', async () => {
  const c = await client();
  const a = await enqueue(db, { template: 'hold_created', audience: 'client', clientId: c, vars: { apt: 41 } }, { env: ENV, render });
  const r = await row(a.id);
  assert.equal(r.status, 'pending');
  assert.equal(Number(r.chat_id), 777);
  assert.equal(r.lang, 'uz');
  assert.deepEqual(r.rendered, { text: 'hold_created:uz:41' });

  const none = await enqueue(db, { template: 'hold_created', audience: 'client', clientId: await client({ chat: null }), vars: {} }, { env: ENV });
  assert.deepEqual(await (async () => { const x = await row(none.id); return [x.status, x.skip_reason]; })(), ['skipped', 'no_telegram']);
  const blocked = await enqueue(db, { template: 'x', audience: 'client', clientId: await client({ chat: 5, blocked: new Date() }), vars: {} }, { env: ENV });
  assert.equal((await row(blocked.id)).skip_reason, 'blocked');
  const group = await enqueue(db, { template: 'staff_booking_paid', audience: 'staff_group', vars: {} }, { env: {} });
  assert.equal((await row(group.id)).skip_reason, 'disabled');
  const grp = await enqueue(db, { template: 'staff_booking_paid', audience: 'staff_group', vars: {} }, { env: ENV });
  assert.equal(Number((await row(grp.id)).chat_id), -100500);
  const off = await enqueue(db, { template: 'x', audience: 'client', clientId: c, vars: {} }, { env: { ...ENV, NOTIFY_MODE: 'off' } });
  assert.equal((await row(off.id)).skip_reason, 'off');
});

test('enqueue: one message per dedupe key (I7); event and message commit or roll back with the change', async () => {
  const c = await client();
  const m = { template: 'booking_confirmed', audience: 'client', clientId: c, vars: {}, dedupeKey: 'booking_confirmed:b1' };
  assert.ok(await enqueue(db, m, { env: ENV }));
  assert.equal(await enqueue(db, m, { env: ENV }), null);

  await assert.rejects(db.tx(async q => {
    const ev = await emit(q, 'booking.paid', { clientId: c, apartmentNo: 41 }, { amount: 10_000_000 });
    await enqueue(q, { ...m, dedupeKey: 'booking_confirmed:b2', eventId: ev }, { env: ENV });
    throw new Error('the change failed');
  }));
  assert.equal((await db.one("SELECT count(*)::int AS n FROM events WHERE type = 'booking.paid'")).n, 0);
  assert.equal((await db.one('SELECT count(*)::int AS n FROM outbox')).n, 1);
});

test('classify: Telegram answers → sent / retry / skipped / failed (04 §3.2)', () => {
  assert.deepEqual(classify({ ok: true, messageId: 1 }), { status: 'sent' });
  assert.deepEqual(classify({ ok: false, status: 429, retryAfter: 7 }), { status: 'retry', delayMs: 7000 });
  assert.deepEqual(classify({ ok: false, status: 403 }), { status: 'skipped', reason: 'blocked' });
  assert.deepEqual(classify({ ok: false, status: 400, description: 'Bad Request: message is not modified' }, 'edit'), { status: 'sent' });
  assert.equal(classify({ ok: false, status: 400, description: "can't parse entities" }).status, 'failed');
  assert.equal(classify({ ok: false, status: 502 }).status, 'retry');
  assert.equal(classify({ ok: false, network: true }).status, 'retry');
});

test('deliver: sent once even if called twice; 403 marks the client blocked', async () => {
  const c = await client();
  const sent = [];
  const send = async r => { sent.push(r.id); return { ok: true, messageId: 99 }; };
  const a = await enqueue(db, { template: 'x', audience: 'client', clientId: c, vars: {} }, { env: ENV });
  await Promise.all([deliver(db, [a.id], send), deliver(db, [a.id], send)]);
  assert.equal(sent.length, 1);
  const r = await row(a.id);
  assert.equal(r.status, 'sent');
  assert.equal(Number(r.tg_message_id), 99);

  const b = await enqueue(db, { template: 'x', audience: 'client', clientId: c, vars: {} }, { env: ENV });
  assert.deepEqual(await deliver(db, [b.id], async () => ({ ok: false, status: 403 })), { sent: 0, retry: 0, skipped: 1, failed: 0 });
  assert.ok((await db.one('SELECT tg_blocked_at FROM clients WHERE id = $1', [c])).tg_blocked_at);
});

test('deliver: network errors retry 30 s, 2 m, 10 m, 1 h, 6 h with an outbox.retry job each, then failed', async () => {
  const c = await client();
  const a = await enqueue(db, { template: 'x', audience: 'client', clientId: c, vars: {} }, { env: ENV });
  const down = async () => { throw new Error('ETIMEDOUT'); };
  for (const wait of ['30s', '2m', '10m', '1h', '6h']) {
    assert.equal((await deliver(db, [a.id], down)).retry, 1);
    assert.equal((await retryDue(db, down)).retry, 0, 'not before its time');
    fakeClock.advance(wait);
  }
  assert.equal((await retryDue(db, down)).failed, 1);
  const r = await row(a.id);
  assert.equal(r.status, 'failed');
  assert.equal(r.attempts, 6);
  assert.equal((await db.one("SELECT count(*)::int AS n FROM jobs WHERE type = 'outbox.retry'")).n, 5);
});

test('deliver: a row stuck in sending is free again after 2 minutes', async () => {
  const c = await client();
  const a = await enqueue(db, { template: 'x', audience: 'client', clientId: c, vars: {} }, { env: ENV });
  await db.query(`UPDATE outbox SET status = 'sending', attempts = 1, next_attempt_at = $2 WHERE id = $1`,
    [a.id, new Date('2026-10-28T05:02:00Z')]);
  const ok = async () => ({ ok: true });
  assert.equal((await retryDue(db, ok)).sent, 0);
  fakeClock.advance('2m');
  assert.equal((await retryDue(db, ok)).sent, 1);
});
