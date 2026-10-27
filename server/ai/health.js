// Provider health (06 §9): a copy of ai_provider_state in memory, re-read every 10 s, own errors applied at once —
// so another function instance learns of a rate_day within 10 s and stops sending requests into nothing.
// Keys: 'gemini', 'anthropic' (the provider) and 'gemini:<model>' (a model).
import { now as clockNow } from '../core/clock.js';
import { nextPacificMidnight, nextTashkentMidnight } from './quota.js';

const REFRESH_MS = 10_000;
const WINDOW_MS = 2 * 60_000;     // «2 in a row within 2 minutes» (§8.1)
const MIN = 60_000;

// db — the base (null: memory only, e.g. scripts); now — the clock.
export function createHealth({ db = null, now = clockNow } = {}) {
  const state = new Map();          // key → { status, until (ms|null), reason }
  const mem = new Map();            // key → { failures, last: [{cls, at}], lastOkAt, okWritten }
  const local = new Map();          // model → reason: disabled until restart (not_found)
  let readAt = -Infinity;

  async function refresh(force = false) {
    const t = now().getTime();
    if (!db || (!force && t - readAt < REFRESH_MS)) return;
    readAt = t;
    try {
      const rows = await db.query('SELECT key, status, cooldown_until, reason FROM ai_provider_state');
      state.clear();
      for (const r of rows) state.set(r.key, { status: r.status, until: r.cooldown_until ? new Date(r.cooldown_until).getTime() : null, reason: r.reason });
    } catch { /* the base is down: keep the copy */ }
  }

  // ok, or a status with until/reason: 'disabled' without until waits for the manual reset (billing).
  function stateOf(key) {
    const s = state.get(key);
    if (!s || s.status === 'ok') return null;
    if (s.until != null && s.until <= now().getTime()) return null;
    return s;
  }

  // → null (available) or the reason to skip the model.
  function skip(model, provider) {
    if (local.has(model)) return local.get(model);
    return (stateOf(provider) || stateOf(`${provider}:${model}`))?.reason || null;
  }

  async function write(key, status, until, reason) {
    const t = now();
    state.set(key, { status, until: until ?? null, reason });
    if (!db) return;
    try {
      await db.query(`INSERT INTO ai_provider_state (key, status, cooldown_until, reason, failures, last_error_at, updated_at)
        VALUES ($1, $2, $3, $4, 1, $5, $5)
        ON CONFLICT (key) DO UPDATE SET status = EXCLUDED.status, cooldown_until = EXCLUDED.cooldown_until, reason = EXCLUDED.reason,
          failures = ai_provider_state.failures + 1, last_error_at = EXCLUDED.last_error_at, updated_at = EXCLUDED.updated_at`,
        [key, status, until == null ? null : new Date(until), reason, t]);
    } catch { /* a lost mark costs one more failed request, not a turn */ }
  }

  const memOf = key => mem.get(key) || mem.set(key, { failures: 0, last: [], lastOkAt: 0 }).get(key);

  async function ok(provider, model) {
    const key = `${provider}:${model}`;
    const m = memOf(key);
    m.failures = 0;
    m.last = [];
    const t = now().getTime();
    const wasBad = state.has(key) && state.get(key).status !== 'ok';
    if (db && (wasBad || t - m.lastOkAt > 60_000)) {
      try {
        await db.query(`INSERT INTO ai_provider_state (key, status, failures, last_ok_at, updated_at) VALUES ($1, 'ok', 0, $2, $2)
          ON CONFLICT (key) DO UPDATE SET status = 'ok', cooldown_until = NULL, reason = NULL, failures = 0, last_ok_at = $2, updated_at = $2`,
        [key, new Date(t)]);
      } catch { /* next time */ }
    }
    m.lastOkAt = t;
    if (wasBad) state.set(key, { status: 'ok', until: null, reason: null });
  }

  // §8.1: what an error class does to the model or the provider.
  async function fail(provider, model, err) {
    const key = `${provider}:${model}`;
    const t = now().getTime();
    const m = memOf(key);
    m.failures++;
    m.last = [...m.last.filter(x => t - x.at < WINDOW_MS), { cls: err.cls, at: t }];
    const twice = cls => m.last.filter(x => cls.includes(x.cls)).length >= 2;
    switch (err.cls) {
      case 'rate_minute': return write(key, 'cooldown', t + (err.retryMs || MIN), 'rate_minute');
      case 'rate_day': return write(key, 'cooldown', nextPacificMidnight(new Date(t)).getTime(), 'rate_day');
      case 'overloaded': case 'server':
        if (twice(['overloaded', 'server'])) { m.last = []; return write(key, 'cooldown', t + MIN, err.cls); }
        return;
      case 'timeout':
        if (twice(['timeout'])) { m.last = []; return write(key, 'cooldown', t + MIN, 'timeout'); }
        return;
      case 'auth': return write(provider, 'disabled', t + 15 * MIN, 'auth');
      case 'billing': return write(provider, 'disabled', null, 'billing');
      case 'not_found':
        local.set(model, 'not_found');
        console.warn(`AI model not found: ${model} — fix server/ai/models.js`);
        return;
      default: return;   // network, malformed, bad_request, refusal: memory only
    }
  }

  // §7: the minute almost used up → skip the model for the rest of it.
  const cooldown = (provider, model, until, reason) => write(`${provider}:${model}`, 'cooldown', until, reason);
  // §14.4: Claude spending over the day's budget → off till Tashkent midnight.
  const budget = () => write('anthropic', 'disabled', nextTashkentMidnight(now()).getTime(), 'budget');
  // §9.3: «Сбросить состояние» (head): clears cooldown and disabled of a key.
  async function reset(key) {
    state.delete(key);
    local.delete(key.split(':')[1]);
    if (db) await db.query('DELETE FROM ai_provider_state WHERE key = $1', [key]);
  }

  return { refresh, skip, ok, fail, cooldown, budget, reset, snapshot: () => Object.fromEntries(state), failures: key => memOf(key).failures };
}
