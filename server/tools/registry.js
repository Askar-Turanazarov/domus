// The tool registry (08 §2, §4, §5, §9, §10, D-02): one layer, three entries (chat agents, MCP, the analyst). A tool is a
// described core call — name, zod schema, roles, whether it changes something; no rules of its own.
// The legacy Domus MCP tools (index.js, over apartments.json) stay until D3-14 moves server/mcp onto this registry.
//
//   createTools({ db, settings?, env?, tools? }) → { get, list, schemas, run }
//   run(name, args, ctx) — ctx { actor, source: 'agent'|'mcp', turnId?, conversationId?, lang, now?, contactPhone?,
//     onCommit?, render? } → { ok: true, out, model } | { ok: true, needsConfirmation: true, preview, model }
//     | { ok: false, error, message, fields?, model }
import { z } from 'zod';
import { DomainError } from '../core/errors.js';
import { now as clockNow } from '../core/clock.js';
import { t } from '../i18n/index.js';
import { CLIENT_TOOLS } from './client.js';
export { defineTool, SOURCES } from './define.js';

export const TIMEOUT_MS = 5000;

// zod → JSON Schema for the models (Gemini parametersJsonSchema, Claude strict) and MCP, without the $schema line.
export function jsonSchema(schema) {
  const { $schema, ...rest } = z.toJSONSchema(schema);
  return rest;
}

const allowed = (tool, ctx) => tool.roles.includes(ctx.actor?.role) && tool.sources.includes(ctx.source);

const fail = (code, lang, vars = {}) => {
  const message = t(lang, `err.${code}`, vars) ?? t(lang, 'err.internal');
  const res = { ok: false, error: code, message };
  if (vars.fields) res.fields = vars.fields;
  res.model = { error: code, message, ...(vars.fields ? { fields: vars.fields } : {}) };
  return res;
};

function withTimeout(promise, ms) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new DomainError('tool_timeout')), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

export function createTools({ db, settings = null, env = process.env, tools = CLIENT_TOOLS, timeoutMs = TIMEOUT_MS, log = console } = {}) {
  const byName = new Map(tools.map(x => [x.name, x]));

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
  const toolCtx = ctx => ({ ...ctx, db, settings, env, core: { now: ctx.now, env, settings, onCommit: ctx.onCommit, render: ctx.render } });

  // Runs fn (the tool's run or preview) under the timeout; DomainError → its code, anything else → internal.
  async function call(tool, fn, args, ctx, { phase = null, pendingActionId = null } = {}) {
    const t0 = performance.now();
    let res;
    try {
      const out = await withTimeout(Promise.resolve().then(() => fn(args, toolCtx(ctx))), timeoutMs);
      res = { ok: true, out };
    } catch (e) {
      if (!(e instanceof DomainError)) log.error?.(`tool ${tool.name} failed:`, e);
      res = e instanceof DomainError ? fail(e.code, ctx.lang, e.vars) : fail('internal', ctx.lang);
    }
    await journal(ctx, { tool: tool.name, phase, pendingActionId, args: tool.redact(args), ok: res.ok, error: res.error,
      ms: Math.round(performance.now() - t0) });
    return res;
  }

  async function run(name, args = {}, ctxIn = {}) {
    const ctx = { lang: 'ru', now: clockNow, ...ctxIn };
    const tool = byName.get(name);
    if (!tool) {                                                                                  // 1
      await journal(ctx, { tool: name, args: null, ok: false, error: 'unknown_tool', ms: 0 });
      return fail('unknown_tool', ctx.lang);
    }
    if (!allowed(tool, ctx)) {                                                                    // 2
      await journal(ctx, { tool: name, args: null, ok: false, error: 'forbidden', ms: 0 });
      return fail('forbidden', ctx.lang);
    }
    const parsed = tool.input.safeParse(args ?? {});                                              // 3
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.flatMap(i => i.path.length ? [String(i.path[0])] : (i.keys ?? [])))];
      await journal(ctx, { tool: name, args: null, ok: false, error: 'invalid_input', ms: 0 });
      return fail('invalid_input', ctx.lang, { fields });
    }
    if (tool.mutates) {                                                                           // 4 — the draft (§6.1 step 1)
      const res = await call(tool, tool.preview, parsed.data, ctx, { phase: 'preview' });
      if (!res.ok) return res;
      return { ok: true, needsConfirmation: true, args: parsed.data, preview: res.out, model: { needsConfirmation: true, preview: res.out } };
    }
    const res = await call(tool, tool.run, parsed.data, ctx);                                     // 5, 6
    return res.ok ? { ...res, model: tool.forModel(res.out, ctx) } : res;                         // 7
  }

  // Executes a mutating tool with args already checked and confirmed (§6.1 step 3 — called by the pending protocol).
  async function execute(name, args, ctxIn = {}, { pendingActionId = null } = {}) {
    const ctx = { lang: 'ru', now: clockNow, ...ctxIn };
    const tool = byName.get(name);
    if (!tool?.mutates) return fail('unknown_tool', ctx.lang);
    if (!allowed(tool, ctx)) return fail('forbidden', ctx.lang);
    const res = await call(tool, tool.run, args, ctx, { phase: 'execute', pendingActionId });
    return res.ok ? { ...res, model: tool.forModel(res.out, ctx) } : res;
  }

  return {
    get: name => byName.get(name) ?? null,
    list: ctx => tools.filter(x => allowed(x, ctx)),
    // The functions a model sees for this actor and entry: name, English description, JSON Schema.
    schemas: ctx => tools.filter(x => allowed(x, ctx)).map(x => ({ name: x.name, description: x.description, parameters: jsonSchema(x.input) })),
    run,
    execute
  };
}
