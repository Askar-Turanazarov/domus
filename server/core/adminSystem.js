// The «Система» screen of the admin (12 §10, 06 §9.3, §11): the business settings with their checks (02 §3.1), the services and
// the AI providers in a human form, the manual reset of a provider's state. The head only; every change is an event `settings.changed`.
import { DomainError, need, staffIdOf } from './errors.js';
import { context, inTx } from './tx.js';
import { emit } from './events.js';
import { DEFAULT_SETTINGS } from './defaults.js';
import { validSetting } from './settings.js';
import { health as servicesHealth } from '../health.js';
import { aiCosts } from './adminAi.js';
import { CHAINS, MODELS, KEY_VAR, hasKey } from '../ai/models.js';

// offer_version and bank_requisites change together with the files in the repository (12 §10.1): the screen only shows them.
export const VIEW_ONLY = ['offer_version', 'bank_requisites'];

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const time = d => (d == null ? null : new Date(d).toISOString());

const item = (key, row) => ({
  key, value: row ? row.value : DEFAULT_SETTINGS[key], updatedAt: row ? time(row.updated_at) : null,
  updatedBy: row?.staff_name ?? null, editable: !VIEW_ONLY.includes(key)
});

// → { items }: every key of 02 §3.1 (the default when the table has no row), in the order of the defaults.
export async function listSettings(q, actor, opts = {}) {
  need(actor, 'head');
  context(opts);
  const rows = await q.query('SELECT s.key, s.value, s.updated_at, st.name AS staff_name FROM settings s LEFT JOIN staff st ON st.id = s.updated_by');
  const byKey = new Map(rows.map(r => [r.key, r]));
  return { items: Object.keys(DEFAULT_SETTINGS).map(k => item(k, byKey.get(k))) };
}

// expectedUpdatedAt — the item's updatedAt the form was opened with (null: the key had no row). Another save in between → stale
// with the current item in vars.current. → { item }.
export async function changeSetting(db, key, { value, expectedUpdatedAt = null } = {}, actor, opts = {}) {
  need(actor, 'head');
  const ctx = context(opts);
  if (!(key in DEFAULT_SETTINGS)) throw new DomainError('not_found');
  if (VIEW_ONLY.includes(key) || !validSetting(key, value)) throw new DomainError('invalid_input', { fields: [VIEW_ONLY.includes(key) ? 'key' : 'value'] });
  const out = await inTx(db, ctx, async q => {
    const row = await q.one('SELECT s.key, s.value, s.updated_at, st.name AS staff_name FROM settings s LEFT JOIN staff st ON st.id = s.updated_by WHERE s.key = $1 FOR UPDATE OF s', [key]);
    const was = time(row?.updated_at);
    if (was !== (expectedUpdatedAt == null ? null : time(expectedUpdatedAt))) throw new DomainError('stale', { current: item(key, row) });
    const from = row ? row.value : DEFAULT_SETTINGS[key];
    if (row && sameValue(from, value)) return item(key, row);
    const at = ctx.now();
    await q.query(`INSERT INTO settings (key, value, updated_at, updated_by) VALUES ($1, $2, $3, $4)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
    [key, JSON.stringify(value), at, staffIdOf(actor)]);
    await emit(q, 'settings.changed', { staffId: staffIdOf(actor) }, { key, from, to: value }, actor, ctx);
    return item(key, await q.one('SELECT s.key, s.value, s.updated_at, st.name AS staff_name FROM settings s LEFT JOIN staff st ON st.id = s.updated_by WHERE s.key = $1', [key]));
  });
  opts.settings?.drop?.();
  return { item: out };
}

const PROVIDERS = ['gemini', 'anthropic'];
const KEY_RE = /^(gemini|anthropic)(:[a-z0-9.-]{1,60})?$/;

// What the table says of a key now: null — available (no row, ok, or the cooldown is over).
function stateOf(rows, key, at) {
  const s = rows.get(key);
  if (!s || s.status === 'ok') return null;
  const until = s.cooldown_until ? new Date(s.cooldown_until).getTime() : null;
  if (until != null && until <= at) return null;
  return { status: s.status, until: until == null ? null : new Date(until).toISOString(), reason: s.reason };
}

// 06 §9.3 for the staff: the key, the status and the demo switch of each provider, the models with the counters of the day,
// «who answers now» for the roles, the spent money. ai_provider_state is read from the base (the copies in memory of other
// instances are up to 10 s late).
export async function aiPanel(q, actor, opts = {}) {
  need(actor, 'head');
  const ctx = context(opts);
  const at = ctx.now().getTime();
  const env = ctx.env;
  const rows = new Map((await q.query('SELECT key, status, cooldown_until, reason FROM ai_provider_state')).map(r => [r.key, r]));
  const sw = (await q.one("SELECT value FROM settings WHERE key = 'ai'"))?.value ?? DEFAULT_SETTINGS.ai;
  const costs = await aiCosts(q, { days: 1 }, actor, ctx);
  const used = new Map(costs.today.gemini.map(g => [g.model, g.used]));

  const providers = {};
  for (const p of PROVIDERS) {
    const models = {};
    for (const [name, cfg] of Object.entries(MODELS).filter(([, c]) => c.provider === p && c.role !== 'embed')) {
      models[name] = { status: 'ok', ...stateOf(rows, `${p}:${name}`, at), ...(p === 'gemini' ? { today: used.get(name) ?? 0, limit: cfg.rpd } : {}) };
    }
    const whole = stateOf(rows, p, at);
    providers[p] = { key: hasKey(p, env), status: whole?.status ?? 'ok', ...(whole ?? {}), ...(p === 'gemini' ? { demoDisabled: Boolean(sw.geminiDisabled) } : {}), models };
  }

  // The first model of a chain that has a key, is not switched off by hand and is not in cooldown / disabled.
  const answering = {};
  for (const [role, chain] of Object.entries(CHAINS)) {
    const at0 = chain.findIndex((name, i) => {
      const p = MODELS[name].provider;
      return hasKey(p, env) && !(sw.geminiDisabled && p === 'gemini') && !(sw.primaryDisabled && i === 0)
        && !stateOf(rows, p, at) && !stateOf(rows, `${p}:${name}`, at);
    });
    answering[role] = at0 < 0 ? { model: null, mode: 'scripts' } : { model: chain[at0], mode: at0 === 0 ? 'primary' : 'reserve' };
  }
  return {
    providers, answering, embeddings: hasKey('gemini', env) && !sw.geminiDisabled && !stateOf(rows, 'gemini', at) ? 'ok' : 'keywords',
    switches: { geminiDisabled: Boolean(sw.geminiDisabled), primaryDisabled: Boolean(sw.primaryDisabled), geminiTier: sw.geminiTier },
    reserveKey: hasKey('anthropic', env), spentTodayUsd: costs.today.paidUsd, budgetUsd: costs.today.budgetUsd
  };
}

// The services in a human form (16 §6) with the last error of the Telegram webhook and the key presence; no values of the keys.
export async function systemHealth(db, actor, opts = {}) {
  need(actor, 'head');
  const ctx = context(opts);
  const { body } = await servicesHealth(db, { env: ctx.env, now: ctx.now });
  const tg = await db.one(`SELECT (SELECT error FROM telegram_updates WHERE error IS NOT NULL ORDER BY received_at DESC LIMIT 1) AS last_error,
      (SELECT received_at FROM telegram_updates ORDER BY received_at DESC LIMIT 1) AS last_at,
      (SELECT count(*)::int FROM telegram_updates WHERE done_at IS NULL AND error IS NULL AND received_at < $1) AS stuck`, [new Date(ctx.now().getTime() - 60_000)]);
  const queue = await db.one(`SELECT count(*) FILTER (WHERE status = 'scheduled' AND run_at < $1)::int AS late,
      count(*) FILTER (WHERE status = 'scheduled')::int AS scheduled FROM jobs`, [ctx.now()]);
  const outbox = await db.one("SELECT count(*) FILTER (WHERE status IN ('failed'))::int AS failed, count(*) FILTER (WHERE status IN ('pending','retry','sending'))::int AS waiting FROM outbox");
  return {
    db: body.db, qstash: body.qstash, telegram: body.telegram, stripe: body.stripe, click: body.click, version: body.version,
    telegramWebhook: { lastAt: time(tg?.last_at), lastError: tg?.last_error ?? null, stuck: tg?.stuck ?? 0 },
    jobs: { scheduled: queue?.scheduled ?? 0, late: queue?.late ?? 0 }, outbox: { failed: outbox?.failed ?? 0, waiting: outbox?.waiting ?? 0 },
    keys: Object.fromEntries(Object.entries(KEY_VAR).map(([p, v]) => [p, Boolean(ctx.env[v])]))
  };
}

// 06 §9.3: clears cooldown and disabled of a key (also `billing`, which never clears itself, 06 §8.1). ai — the AI layer, so the copy
// in memory of this instance goes too; others read the base within 10 s. → { state }.
export async function resetProvider(db, key, actor, opts = {}) {
  need(actor, 'head');
  context(opts);
  if (!KEY_RE.test(String(key))) throw new DomainError('invalid_input', { fields: ['key'] });
  if (opts.ai?.health) await opts.ai.health.reset(key);
  else await db.query('DELETE FROM ai_provider_state WHERE key = $1', [key]);
  return { state: { key, status: 'ok', until: null, reason: null } };
}
