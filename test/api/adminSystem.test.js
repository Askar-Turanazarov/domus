// 12 §10, 13 §9, 06 §9.3, §11: settings over HTTP with the real staff gate — the list with defaults, a save with the checks of 02 §3.1,
// the event, a second save by a stale form (409 with the current item), the view-only keys, the demo switches and who answers now,
// the reset of a provider's state, the services panel. The head only.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { fakeClock, now } from '../../server/core/clock.js';
import { hashPassword } from '../../server/adminAuth.js';
import { createStaff } from '../../server/core/staff.js';
import { createSettings } from '../../server/core/settings.js';
import { mountAdmin } from '../../server/http/admin.js';
import { mountAdminSystem } from '../../server/http/adminSystem.js';
import { requestId, apiErrors } from '../../server/http/common.js';
import { createHealth } from '../../server/ai/health.js';
import { createTestDb, resetDb } from '../support/db.js';

const PASSWORD = 'system test password 1';
const ENV = { LINK_SECRET: 'test-secret', SESSION_SECRET: 'x'.repeat(40), LOG_SALT: 'salt', GEMINI_API_KEY: 'k', ANTHROPIC_API_KEY: 'a', AI_DAILY_BUDGET_USD: '5' };
let db, server, base, cookies, settings, health, env = ENV;

before(async () => {
  db = await createTestDb();
  const app = express();
  app.use(requestId);
  const staffAuth = mountAdmin(app, db, { env: ENV, cacheMs: 0 });
  settings = createSettings(db, { ttlMs: 60_000 });
  health = createHealth({ db });
  mountAdminSystem(app, db, staffAuth, { env: new Proxy({}, { get: (_, k) => env[k] }), ai: { health }, settings });
  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));
  app.use(apiErrors);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); return db.close(); });

let staff;
beforeEach(async () => {
  await resetDb(db);
  env = ENV;
  fakeClock.set('2026-10-28T10:00:00+05:00');
  const passwordHash = await hashPassword(PASSWORD);
  cookies = {}; staff = {};
  for (const role of ['manager', 'head']) {
    staff[role] = await createStaff(db, { login: 'u-' + role, name: role, role, passwordHash });
    const res = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'domus-admin' },
      body: JSON.stringify({ login: 'u-' + role, password: PASSWORD }) });
    assert.equal(res.status, 200);
    cookies[role] = res.headers.get('set-cookie').split(';')[0];
  }
});
afterEach(() => fakeClock.reset());

async function call(method, path, { role = 'head', body } = {}) {
  const headers = { 'X-Requested-With': 'domus-admin' };
  if (role) headers.cookie = cookies[role];
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
// The settings table is seeded by the migration (02 §3.1): a form is opened with the row's time unless the test says otherwise.
const stamp = async key => (await db.one('SELECT updated_at FROM settings WHERE key = $1', [key])).updated_at.toISOString();
const put = async (key, value, expectedUpdatedAt, role = 'head') => call('PUT', '/api/admin/settings/' + key,
  { role, body: { value, expectedUpdatedAt: expectedUpdatedAt === undefined ? await stamp(key).catch(() => null) : expectedUpdatedAt } });

test('settings, system and the reset are for the head only', async () => {
  const entries = [['GET', '/api/admin/settings'], ['PUT', '/api/admin/settings/hold_minutes', { value: 20 }], ['GET', '/api/admin/system'], ['POST', '/api/admin/ai/providers/gemini/reset', {}]];
  for (const [m, p, body] of entries) {
    assert.equal((await call(m, p, { role: null, body })).status, 401, p);
    assert.equal((await call(m, p, { role: 'manager', body })).status, 403, p);
  }
});

test('the list: every key with the seeded value, nobody as the editor, view-only marked', async () => {
  const { items } = (await call('GET', '/api/admin/settings')).body;
  assert.equal(items.length, 12);
  const hold = items.find(i => i.key === 'hold_minutes');
  assert.deepEqual({ ...hold, updatedAt: typeof hold.updatedAt }, { key: 'hold_minutes', value: 15, updatedAt: 'string', updatedBy: null, editable: true });
  assert.equal(items.find(i => i.key === 'offer_version').editable, false);
  assert.equal(items.find(i => i.key === 'bank_requisites').editable, false);
});

test('a save: the value, who and when, the event {key, from, to}; the list shows it; the cache of the instance is dropped', async () => {
  assert.equal(await settings.get('hold_minutes'), 15);
  const r = await put('hold_minutes', 20);
  assert.equal(r.status, 200);
  assert.equal(r.body.item.value, 20);
  assert.equal(r.body.item.updatedAt, now().toISOString());
  assert.equal(r.body.item.updatedBy, 'head');
  const ev = await db.one("SELECT actor, data, staff_id FROM events WHERE type = 'settings.changed'");
  assert.deepEqual(ev.data, { key: 'hold_minutes', from: 15, to: 20 });
  assert.equal(ev.staff_id, staff.head.id);
  assert.equal(ev.actor.type, 'staff');
  const item = (await call('GET', '/api/admin/settings')).body.items.find(i => i.key === 'hold_minutes');
  assert.equal(item.value, 20);
  assert.equal(item.updatedBy, 'head');
  assert.equal(await settings.get('hold_minutes'), 20);
});

test('the checks of 02 §3.1: out of range, wrong type, a broken table, an unknown key, a view-only key', async () => {
  const bad = [['hold_minutes', 4], ['hold_minutes', 61], ['hold_minutes', '20'], ['deposit_amount', 1_000_500], ['booking_hours', 10],
    ['max_active_bookings', 6], ['furniture_prepay_pct', 5], ['extend_max_hours', 0],
    ['installment', { minDownPct: 30, terms: [] }], ['installment', { minDownPct: 5, terms: [{ months: 12, markupPct: 0 }] }],
    ['installment', { minDownPct: 30, terms: [{ months: 2, markupPct: 0 }] }],
    ['reminders', { bookingHoursBefore: [24, 3], viewingHoursBefore: 60 }], ['chat_limits', { perMinute: 0, perDay: 200, perConversation: 40 }],
    ['ai', { geminiDisabled: 'yes', primaryDisabled: false, geminiTier: 'free' }], ['ai', { geminiDisabled: false, primaryDisabled: false, geminiTier: 'gold' }]];
  for (const [key, value] of bad) {
    const r = await put(key, value);
    assert.equal(r.status, 400, `${key} ${JSON.stringify(value)}`);
    assert.equal(r.body.error, 'invalid_input');
    assert.deepEqual(r.body.fields, ['value']);
  }
  assert.equal((await put('offer_version', '2026-11-01')).status, 400);
  assert.equal((await put('bank_requisites', { name: 'x' })).status, 400);
  assert.equal((await put('no_such_key', 1)).status, 404);
  assert.equal((await call('PUT', '/api/admin/settings/hold_minutes', { body: { expectedUpdatedAt: null } })).status, 400);   // no value
  assert.equal((await call('PUT', '/api/admin/settings/hold_minutes', { body: { value: 20, extra: 1 } })).status, 400);
  assert.deepEqual((await db.one("SELECT value FROM settings WHERE key = 'hold_minutes'")).value, 15);
  assert.equal((await db.one("SELECT count(*)::int AS n FROM events WHERE type = 'settings.changed'")).n, 0);
});

test('an installment table of 1–4 rows is saved as a whole', async () => {
  const value = { minDownPct: 40, terms: [{ months: 6, markupPct: 0 }, { months: 12, markupPct: 2.5 }] };
  assert.equal((await put('installment', value)).status, 200);
  assert.deepEqual((await db.one("SELECT value FROM settings WHERE key = 'installment'")).value, value);
});

test('stale: a second form opened before the first save is refused with the current item; with the fresh updatedAt it passes', async () => {
  const opened = await stamp('hold_minutes');
  const first = await put('hold_minutes', 20);
  assert.equal(first.status, 200);
  fakeClock.set('2026-10-28T10:05:00+05:00');
  const late = await put('hold_minutes', 30, opened);                              // the form was opened before the first save
  assert.equal(late.status, 409);
  assert.equal(late.body.error, 'stale');
  assert.equal(late.body.vars.current.value, 20);
  assert.equal(late.body.vars.current.updatedAt, first.body.item.updatedAt);
  assert.equal((await put('hold_minutes', 30, null)).status, 409);                         // a form of a key that had no row
  const ok = await put('hold_minutes', 30, late.body.vars.current.updatedAt);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.item.value, 30);
  assert.equal((await db.one("SELECT count(*)::int AS n FROM events WHERE type = 'settings.changed'")).n, 2);
});

test('the same value again changes nothing: no new time, no event', async () => {
  const first = await put('hold_minutes', 20);
  fakeClock.set('2026-10-28T11:00:00+05:00');
  const again = await put('hold_minutes', 20, first.body.item.updatedAt);
  assert.equal(again.status, 200);
  assert.equal(again.body.item.updatedAt, first.body.item.updatedAt);
  assert.equal((await db.one("SELECT count(*)::int AS n FROM events WHERE type = 'settings.changed'")).n, 1);
});

test('the demo switch: saved as the key «ai», the panel names who answers now; the reserve is a model of the other chain end', async () => {
  const before = (await call('GET', '/api/admin/system')).body.ai;
  assert.deepEqual(before.answering.tools, { model: 'gemini-3.8-flash', mode: 'primary' });
  assert.deepEqual(before.answering.fast, { model: 'gemini-3.5-flash-lite', mode: 'primary' });
  assert.equal(before.providers.gemini.demoDisabled, false);

  const r = await put('ai', { geminiDisabled: true, primaryDisabled: false, geminiTier: 'free' });
  assert.equal(r.status, 200);
  const off = (await call('GET', '/api/admin/system')).body.ai;
  assert.equal(off.providers.gemini.demoDisabled, true);
  assert.deepEqual(off.answering.tools, { model: 'claude-sonnet-5-5', mode: 'reserve' });
  assert.deepEqual(off.answering.fast, { model: 'claude-haiku-5-5', mode: 'reserve' });
  assert.equal(off.embeddings, 'keywords');

  env = { ...ENV, ANTHROPIC_API_KEY: '' };                                          // no reserve key: the scripts answer
  const none = (await call('GET', '/api/admin/system')).body.ai;
  assert.deepEqual(none.answering.tools, { model: null, mode: 'scripts' });
  assert.equal(none.reserveKey, false);

  env = ENV;
  await put('ai', { geminiDisabled: false, primaryDisabled: true, geminiTier: 'paid' }, r.body.item.updatedAt);
  const second = (await call('GET', '/api/admin/system')).body.ai;
  assert.deepEqual(second.answering.tools, { model: 'gemini-3.6-flash', mode: 'reserve' });
  assert.equal(second.switches.geminiTier, 'paid');
});

test('the panel: a model in cooldown, the counter of the day, the key presence without values, the money spent', async () => {
  const until = new Date(now().getTime() + 3600e3);
  await db.query("INSERT INTO ai_provider_state (key, status, cooldown_until, reason, updated_at) VALUES ('gemini:gemini-3.8-flash', 'cooldown', $1, 'rate_day', $2)", [until, now()]);
  await db.query("INSERT INTO ai_provider_state (key, status, reason, updated_at) VALUES ('anthropic', 'disabled', 'billing', $1)", [now()]);
  for (let i = 0; i < 3; i++) await db.query("INSERT INTO ai_calls (at, agent, provider, model, kind, ok, input_tokens, output_tokens, cost_usd, ms) VALUES ($1, 'router', 'gemini', 'gemini-3.8-flash', 'chat', true, 1, 1, 0, 10)", [now()]);

  const { ai, services } = (await call('GET', '/api/admin/system')).body;
  const m = ai.providers.gemini.models['gemini-3.8-flash'];
  assert.equal(m.status, 'cooldown');
  assert.equal(m.reason, 'rate_day');
  assert.equal(m.until, until.toISOString());
  assert.equal(m.today, 3);
  assert.equal(m.limit, 1500);
  assert.equal(ai.providers.gemini.models['gemini-3.6-flash'].status, 'ok');
  assert.equal(ai.providers.anthropic.status, 'disabled');
  assert.equal(ai.providers.anthropic.reason, 'billing');
  assert.deepEqual(ai.answering.tools, { model: 'gemini-3.6-flash', mode: 'reserve' });
  assert.equal(ai.providers.gemini.key, true);
  assert.equal(ai.budgetUsd, 5);
  assert.equal(services.db, 'ok');
  assert.deepEqual(services.keys, { gemini: true, anthropic: true });
  assert.ok(!JSON.stringify({ ai, services }).includes('"a"') && !JSON.stringify({ ai, services }).includes(ENV.LINK_SECRET));
});

test('the services: Telegram webhook last error, late jobs, failed Outbox', async () => {
  await db.query("INSERT INTO telegram_updates (update_id, kind, received_at, done_at, error) VALUES (1, 'message', $1, $1, 'boom')", [now()]);
  await db.query("INSERT INTO telegram_updates (update_id, kind, received_at) VALUES (2, 'message', $1)", [new Date(now().getTime() - 120e3)]);
  const { services } = (await call('GET', '/api/admin/system')).body;
  assert.equal(services.telegramWebhook.lastError, 'boom');
  assert.equal(services.telegramWebhook.stuck, 1);
  assert.deepEqual(services.jobs, { scheduled: 0, late: 0 });
  assert.deepEqual(services.outbox, { failed: 0, waiting: 0 });
});

test('the reset clears a cooldown and a billing block, also in memory; a bad key is refused', async () => {
  await db.query("INSERT INTO ai_provider_state (key, status, reason, updated_at) VALUES ('anthropic', 'disabled', 'billing', $1)", [now()]);
  await health.refresh(true);
  assert.equal(health.skip('claude-sonnet-5-5', 'anthropic'), 'billing');
  const r = await call('POST', '/api/admin/ai/providers/anthropic/reset', { body: {} });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.state, { key: 'anthropic', status: 'ok', until: null, reason: null });
  assert.equal(health.skip('claude-sonnet-5-5', 'anthropic'), null);
  assert.equal((await db.one('SELECT count(*)::int AS n FROM ai_provider_state')).n, 0);
  assert.equal((await call('POST', '/api/admin/ai/providers/gemini:gemini-3.8-flash/reset', { body: {} })).status, 200);
  assert.equal((await call('POST', '/api/admin/ai/providers/evil;drop/reset', { body: {} })).status, 400);
  assert.equal((await call('POST', '/api/admin/ai/providers/openai/reset', { body: {} })).status, 400);
});
