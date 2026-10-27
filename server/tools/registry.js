// The tool registry (08 §2, §4, §5, §9, §10, D-02): one layer, three entries (chat agents, MCP, the analyst). A tool is a
// described core call — name, zod schema, roles, whether it changes something; no rules of its own.
// The legacy Domus MCP tools (index.js, over apartments.json) stay until D3-14 moves server/mcp onto this registry.
//
//   createTools({ db, settings?, env?, tools? }) → { get, list, schemas, run, confirm, decline, renew, pendingOf }
//   run(name, args, ctx) — ctx { actor, source: 'agent'|'mcp', turnId?, conversationId?, lang, now?, contactPhone?, summary?,
//     confirmToken?, onCommit?, render? } →
//       { ok: true, out, model }                                            a reading tool
//     | { ok: true, pending: true, pendingActionId, tool, args, preview, expiresAt, model }   a mutating one: the draft (§6.1)
//       (+ confirmToken for MCP; the agent's model gets only { pending, summary } — 07 §8.1)
//     | { ok: false, error, message, fields?, model }
//   confirm(pendingActionId, ctx) — «Да» (§6.2): → { ok: true, status: 'executed', tool, out, model } | an error
//     (pending_not_found, confirm_mismatch, confirm_expired, confirm_used with the first result, or the core's)
import { z } from 'zod';
import { DomainError } from '../core/errors.js';
import { now as clockNow } from '../core/clock.js';
import { t } from '../i18n/index.js';
import { CLIENT_TOOLS } from './client.js';
import { draft, claim, finish, argsHash, tokenHash, sameActor } from './pending.js';
export { defineTool, SOURCES } from './define.js';

export const TIMEOUT_MS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// zod → JSON Schema for the models (Gemini parametersJsonSchema, Claude strict) and MCP, without the $schema line.
export function jsonSchema(schema) {
  const { $schema, ...rest } = z.toJSONSchema(schema);
  return rest;
}

const allowed = (tool, ctx) => tool.roles.includes(ctx.actor?.role) && tool.sources.includes(ctx.source);

// { error, message } in the client's language (§10); fields — only the names; extra — what the caller needs (a first result).
const fail = (code, lang, vars = {}, extra = {}) => {
  const message = t(lang, `err.${code}`, vars) ?? t(lang, 'err.internal');
  const res = { ok: false, error: code, message, ...extra };
  if (vars.fields) res.fields = vars.fields;
  res.model = { error: code, message, ...(vars.fields ? { fields: vars.fields } : {}) };
  return res;
};
const failOf = (e, lang) => (e instanceof DomainError ? fail(e.code, lang, e.vars) : fail('internal', lang));

function withTimeout(promise, ms) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new DomainError('tool_timeout')), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// kb — createKb() of the knowledge base (09 §5); without it search_kb searches by words only.
export function createTools({ db, settings = null, env = process.env, tools = CLIENT_TOOLS, timeoutMs = TIMEOUT_MS, log = console, kb = null } = {}) {
  const byName = new Map(tools.map(x => [x.name, x]));
  const withDefaults = ctx => ({ lang: 'ru', now: clockNow, ...ctx });

  // 08 §9: one line per call; a failed write is only reported — the answer still goes out.
  async function journal(ctx, row) {
    try {
      await db.query(`INSERT INTO tool_calls (at, source, tool, role, turn_id, conversation_id, pending_action_id, phase, args, ok, error, ms)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [ctx.now(), ctx.source, row.tool, ctx.actor?.role ?? null, ctx.turnId ?? null, ctx.conversationId ?? null,
        row.pendingActionId ?? null, row.phase ?? null, row.args == null ? null : JSON.stringify(row.args), row.ok, row.error ?? null, row.ms]);
    } catch (e) {
      log.error?.('tool_calls write failed:', e.message);
    }
  }

  // What a tool's run / preview gets: the call context plus the base and the core options.
  const toolCtx = ctx => ({ ...ctx, db, settings, env, kb, core: { now: ctx.now, env, settings, onCommit: ctx.onCommit, render: ctx.render } });

  // Runs fn (the tool's run or preview) under the timeout; DomainError → its code, anything else → internal (never the text).
  // after(out) — more work inside the measured call (the draft row); its id goes to the journal.
  async function call(tool, fn, args, ctx, { phase = null, pendingActionId = null, after = null } = {}) {
    const t0 = performance.now();
    let res;
    let id = pendingActionId;
    try {
      const out = await withTimeout(Promise.resolve().then(() => fn(args, toolCtx(ctx))), timeoutMs);
      res = { ok: true, out };
      if (after) { res.extra = await after(out); id = res.extra.row.id; }
    } catch (e) {
      if (!(e instanceof DomainError)) log.error?.(`tool ${tool.name} failed:`, e);
      res = failOf(e, ctx.lang);
    }
    await journal(ctx, { tool: tool.name, phase, pendingActionId: id, args: tool.redact(args), ok: res.ok, error: res.error,
      ms: Math.round(performance.now() - t0) });
    return res;
  }

  async function run(name, args = {}, ctxIn = {}) {
    const ctx = withDefaults(ctxIn);
    const tool = byName.get(name);
    if (!tool) {                                                                                  // 1
      await journal(ctx, { tool: name, args: null, ok: false, error: 'unknown_tool', ms: 0 });
      return fail('unknown_tool', ctx.lang);
    }
    if (!allowed(tool, ctx)) {                                                                    // 2
      await journal(ctx, { tool: name, args: null, ok: false, error: 'forbidden', ms: 0 });
      return fail('forbidden', ctx.lang);
    }
    let input = args ?? {};
    let token = ctx.confirmToken ?? null;
    if (tool.mutates && ctx.source === 'mcp' && input.confirmToken != null) {                     // §6.3: not part of the args
      ({ confirmToken: token, ...input } = input);
    }
    const parsed = tool.input.safeParse(input);                                                   // 3
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.flatMap(i => i.path.length ? [String(i.path[0])] : (i.keys ?? [])))];
      await journal(ctx, { tool: name, args: null, ok: false, error: 'invalid_input', ms: 0 });
      return fail('invalid_input', ctx.lang, { fields });
    }
    if (!tool.mutates) {
      const res = await call(tool, tool.run, parsed.data, ctx);                                   // 5, 6
      return res.ok ? { ...res, model: tool.forModel(res.out, ctx) } : res;                       // 7
    }
    if (token) return confirmByToken(tool, parsed.data, token, ctx);                              // 4 — MCP, the second call
    return propose(tool, parsed.data, ctx);                                                       // 4 — the draft
  }

  // §6.1 steps 1–2: the preview checks everything it can without writing; an error is an error, no draft.
  async function propose(tool, args, ctx) {
    const res = await call(tool, tool.preview, args, ctx, { phase: 'preview',
      after: preview => draft(db, { tool: tool.name, args, preview, ctx }) });
    if (!res.ok) return res;
    const { row, confirmToken } = res.extra;
    const out = { ok: true, pending: true, pendingActionId: row.id, tool: tool.name, args, preview: res.out,
      expiresAt: row.expires_at.toISOString() };
    if (confirmToken) {
      out.confirmToken = confirmToken;
      out.model = { needsConfirmation: true, confirmToken, preview: res.out, expiresAt: out.expiresAt };
    } else {
      out.model = { pending: true, summary: 'Awaiting the client\'s confirmation: the client sees the terms and presses «Да».' };
    }
    return out;
  }

  // §6.1 step 3 on a found row: claim → the core with the row's args and idempotencyKey = its id → executed / failed.
  async function executeRow(row, ctx) {
    const tool = byName.get(row.tool);
    if (!tool?.mutates || !allowed(tool, ctx)) return fail('forbidden', ctx.lang);
    if (argsHash(row.args) !== row.args_hash) return fail('confirm_mismatch', ctx.lang);
    let got;
    try {
      got = await claim(db, row, ctx);
    } catch (e) {
      if (e.code === 'confirm_used') return fail('confirm_used', ctx.lang, {}, { result: e.vars.result ?? null, status: e.vars.status });
      return failOf(e, ctx.lang);
    }
    const run = { ...ctx, conversationId: got.conversation_id ?? ctx.conversationId, idempotencyKey: got.id };
    const res = await call(tool, tool.run, got.args, run, { phase: 'execute', pendingActionId: got.id });
    await finish(db, got.id, { ok: res.ok, result: res.out, error: res.error });
    return res.ok ? { ...res, status: 'executed', pendingActionId: got.id, tool: tool.name, model: tool.forModel(res.out, ctx) }
      : { ...res, status: 'failed', pendingActionId: got.id, tool: tool.name };
  }

  // §6.2: the button or the text «да». Someone else's draft — confirm_mismatch, never executed.
  async function confirm(pendingActionId, ctxIn = {}) {
    const ctx = withDefaults(ctxIn);
    const row = UUID.test(String(pendingActionId)) ? await db.one('SELECT * FROM pending_actions WHERE id = $1', [pendingActionId]) : null;
    if (!row) return fail('pending_not_found', ctx.lang);
    if (!sameActor(row.actor, ctx.actor) || (row.conversation_id ?? null) !== (ctx.conversationId ?? row.conversation_id ?? null)) {
      return fail('confirm_mismatch', ctx.lang);
    }
    return executeRow(row, { ...ctx, source: row.source });
  }

  // §6.3: the MCP call again with confirmToken — the same tool, the same token role, the same arguments.
  async function confirmByToken(tool, args, token, ctx) {
    const row = await db.one('SELECT * FROM pending_actions WHERE confirm_token_hash = $1', [tokenHash(token)]);
    if (!row) return fail('pending_not_found', ctx.lang);
    if (row.tool !== tool.name || !sameActor(row.actor, ctx.actor) || argsHash(args) !== row.args_hash) return fail('confirm_mismatch', ctx.lang);
    return executeRow(row, ctx);
  }

  // 07 §8.4: «Изменить» / «Отмена» — the draft is cancelled. → { ok, status: 'cancelled', tool } | an error.
  async function decline(pendingActionId, ctxIn = {}) {
    const ctx = withDefaults(ctxIn);
    const row = UUID.test(String(pendingActionId)) ? await db.one('SELECT * FROM pending_actions WHERE id = $1', [pendingActionId]) : null;
    if (!row) return fail('pending_not_found', ctx.lang);
    if (!sameActor(row.actor, ctx.actor)) return fail('confirm_mismatch', ctx.lang);
    const done = await db.one(`UPDATE pending_actions SET status = 'cancelled', decided_at = $2 WHERE id = $1 AND status = 'pending' RETURNING id`,
      [row.id, ctx.now()]);
    if (!done && row.status !== 'cancelled') return fail(['expired'].includes(row.status) ? 'confirm_expired' : 'confirm_used', ctx.lang);
    return { ok: true, status: 'cancelled', tool: row.tool, pendingActionId: row.id };
  }

  // 07 §8.3: «Повторить?» after the time ran out — a new draft with the same arguments and a new preview.
  async function renew(pendingActionId, ctxIn = {}) {
    const ctx = withDefaults(ctxIn);
    const row = UUID.test(String(pendingActionId)) ? await db.one('SELECT * FROM pending_actions WHERE id = $1', [pendingActionId]) : null;
    if (!row) return fail('pending_not_found', ctx.lang);
    if (!sameActor(row.actor, ctx.actor)) return fail('confirm_mismatch', ctx.lang);
    return run(row.tool, row.args, { ...ctx, source: row.source, conversationId: row.conversation_id ?? ctx.conversationId });
  }

  // The live drafts of a dialog (the text «да» needs exactly one, 07 §3.3).
  const pendingOf = async (conversationId, now = clockNow) => db.query(`SELECT * FROM pending_actions
    WHERE conversation_id = $1 AND status = 'pending' AND expires_at > $2 ORDER BY created_at`, [conversationId, now()]);

  return {
    get: name => byName.get(name) ?? null,
    list: ctx => tools.filter(x => allowed(x, ctx)),
    // The functions a model sees for this actor and entry: name, English description, JSON Schema.
    schemas: ctx => tools.filter(x => allowed(x, ctx)).map(x => ({ name: x.name, description: x.description, schema: jsonSchema(x.input) })),
    run,
    confirm,
    decline,
    renew,
    pendingOf
  };
}
