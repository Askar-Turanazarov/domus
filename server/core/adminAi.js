// Read models of the AI screens of the admin (12 §8, 07 §16.2, 08 §9, 06 §14, 09 §8): the journal of agent turns with the tree of one
// turn, the journal of tool calls, the costs by day, the knowledge base (chunks, «without an answer») and its reindex. The managers
// see only the turns of their own clients; everything else is the head's. Texts of prompts are never stored here, tool arguments
// are already masked by the registry (08 §9).
import { DomainError, need } from './errors.js';
import { context } from './tx.js';
import { MODELS, dailyBudgetUsd } from '../ai/models.js';
import { pacificDayStart, tashkentDayStart } from '../ai/quota.js';
import { ingest } from '../kb/ingest.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encodeCursor = (key, tie) => Buffer.from(JSON.stringify([new Date(key).toISOString(), String(tie)])).toString('base64url');
function decodeCursor(c) {
  if (c == null || c === '') return null;
  try {
    const [key, tie] = JSON.parse(Buffer.from(String(c), 'base64url').toString());
    if (Number.isNaN(new Date(key).getTime()) || typeof tie !== 'string' || tie.length > 40) throw new Error('shape');
    return { key: new Date(key), tie };
  } catch {
    throw new DomainError('invalid_input', { fields: ['cursor'] });
  }
}
const pageSize = n => Math.min(200, Math.max(1, Number.isInteger(Number(n)) && Number(n) > 0 ? Number(n) : 50));
const num = v => Number(v ?? 0);

// 07 §15.4, §16.2: what makes a turn «problematic» besides an error, a reserve model or a 👎.
export const PROBLEM_ERRORS = ['injection', 'ungrounded_number', 'max_steps', 'no_citations'];
export const SLOW_MS = 8000;                                  // NFR-PERF-04

// ---- the journal of turns ----

const TURNS = `
  SELECT a.turn_id, min(a.created_at) AS at, (array_agg(a.conversation_id ORDER BY a.id))[1] AS conversation_id,
    array_agg(a.agent ORDER BY a.id) AS agents,
    (SELECT COALESCE(array_agg(DISTINCT x), '{}') FROM agent_runs a2, unnest(a2.tools) x WHERE a2.turn_id = a.turn_id) AS tools,
    (array_agg(a.model ORDER BY a.id DESC) FILTER (WHERE a.model IS NOT NULL))[1] AS model,
    (array_agg(a.provider ORDER BY a.id DESC) FILTER (WHERE a.provider IS NOT NULL))[1] AS provider,
    bool_or(a.fallback) AS fallback, COALESCE(sum(a.ms), 0)::int AS ms, min(a.first_event_ms) AS first_event_ms,
    COALESCE(sum(a.input_tokens), 0)::int AS input_tokens, COALESCE(sum(a.output_tokens), 0)::int AS output_tokens,
    COALESCE(sum(a.cached_tokens), 0)::int AS cached_tokens, COALESCE(sum(a.cost_usd), 0)::float AS cost_usd,
    bool_and(a.ok) AS ok, (array_agg(a.error ORDER BY a.id) FILTER (WHERE a.error IS NOT NULL))[1] AS error,
    bool_or(a.error = ANY($1::text[])) AS flagged
  FROM agent_runs a GROUP BY a.turn_id`;

const FEEDBACK = `(SELECT min(m.feedback) FROM messages m WHERE m.turn_id = t.turn_id)`;

function turnRow(r) {
  return { turnId: r.turn_id, at: r.at, channel: r.channel ?? null, client: r.client_id ? { id: r.client_id, name: r.client_name } : null,
    agents: r.agents, tools: r.tools, model: r.model, provider: r.provider, fallback: !!r.fallback, ms: r.ms, firstEventMs: r.first_event_ms,
    tokens: { input: r.input_tokens, output: r.output_tokens, cached: r.cached_tokens }, costUsd: r.cost_usd, ok: !!r.ok, error: r.error,
    feedback: r.feedback ?? null, problem: !r.ok || !!r.fallback || !!r.flagged || r.ms > SLOW_MS || r.feedback === -1 };
}

// opts-1: { problem, fallback, negative, errors, cursor, limit } → { items, next }, newest first.
export async function agentRuns(q, { problem = false, fallback = false, negative = false, errors = false, cursor = null, limit = 50 } = {}, actor, opts = {}) {
  need(actor, 'manager', 'head');
  context(opts);
  const params = [PROBLEM_ERRORS];
  let where = 'TRUE';
  if (actor.role === 'manager') { params.push(actor.id); where += ` AND v.kind = 'client' AND c.assigned_staff_id = $${params.length}`; }
  if (errors) where += ' AND NOT t.ok';
  if (fallback) where += ' AND t.fallback';
  if (negative) where += ` AND ${FEEDBACK} = -1`;
  if (problem) where += ` AND (NOT t.ok OR t.fallback OR t.flagged OR t.ms > ${SLOW_MS} OR ${FEEDBACK} = -1)`;
  const cur = decodeCursor(cursor);
  if (cur) { params.push(cur.key, cur.tie); where += ` AND (t.at, t.turn_id::text) < ($${params.length - 1}, $${params.length})`; }
  const n = pageSize(limit);
  const rows = await q.query(`SELECT t.*, v.channel, c.id AS client_id, c.name AS client_name, ${FEEDBACK} AS feedback
    FROM (${TURNS}) t LEFT JOIN conversations v ON v.id = t.conversation_id LEFT JOIN clients c ON c.id = v.client_id
    WHERE ${where} ORDER BY t.at DESC, t.turn_id::text DESC LIMIT ${n + 1}`, params);
  const page = rows.slice(0, n);
  const last = page[page.length - 1];
  return { items: page.map(turnRow), next: rows.length > n ? encodeCursor(last.at, last.turn_id) : null };
}

// One turn as a tree: router → agent → model calls → tool calls. → null when there is no such turn (or it is not the manager's).
export async function agentRunTree(q, turnId, actor, opts = {}) {
  need(actor, 'manager', 'head');
  context(opts);
  if (!UUID.test(String(turnId))) return null;
  const runs = await q.query('SELECT * FROM agent_runs WHERE turn_id = $1 ORDER BY id', [turnId]);
  if (!runs.length) return null;
  const conv = runs[0].conversation_id
    ? await q.one(`SELECT v.id, v.kind, v.channel, v.lang, c.id AS client_id, c.name AS client_name, c.assigned_staff_id
        FROM conversations v LEFT JOIN clients c ON c.id = v.client_id WHERE v.id = $1`, [runs[0].conversation_id])
    : null;
  if (actor.role === 'manager' && !(conv?.kind === 'client' && conv.assigned_staff_id === actor.id)) return null;
  const calls = await q.query('SELECT * FROM ai_calls WHERE turn_id = $1 ORDER BY at, id', [turnId]);
  const tools = await q.query('SELECT * FROM tool_calls WHERE turn_id = $1 ORDER BY at, id', [turnId]);
  const messages = await q.query('SELECT role, text, feedback, feedback_note, created_at FROM messages WHERE turn_id = $1 ORDER BY id', [turnId]);

  const taken = new Set();
  const steps = runs.map(r => {
    const mine = tools.filter(tc => !taken.has(tc.id) && tc.tool && r.tools.includes(tc.tool));
    mine.forEach(tc => taken.add(tc.id));
    return {
      agent: r.agent, role: r.role, provider: r.provider, model: r.model, fallback: r.fallback, steps: r.steps, ms: r.ms, firstEventMs: r.first_event_ms,
      tokens: { input: r.input_tokens, output: r.output_tokens, cached: r.cached_tokens }, costUsd: num(r.cost_usd), ok: r.ok, error: r.error,
      calls: calls.filter(c => c.agent === r.agent).map(c => ({ at: c.at, provider: c.provider, model: c.model, kind: c.kind, ok: c.ok, errorClass: c.error_class,
        tokens: { input: c.input_tokens, output: c.output_tokens, cached: c.cached_tokens }, costUsd: num(c.cost_usd), ms: c.ms })),
      tools: mine.map(toolShape)
    };
  });
  return { turnId, at: runs[0].created_at, conversation: conv ? { id: conv.id, channel: conv.channel, lang: conv.lang, client: conv.client_id ? { id: conv.client_id, name: conv.client_name } : null } : null,
    messages: messages.map(m => ({ role: m.role, text: m.text, feedback: m.feedback, note: m.feedback_note, at: m.created_at })),
    steps, otherTools: tools.filter(tc => !taken.has(tc.id)).map(toolShape) };
}

// ---- the journal of tools ----

const toolShape = r => ({ id: Number(r.id), at: r.at, source: r.source, role: r.role, tool: r.tool, phase: r.phase, args: r.args, ok: r.ok, error: r.error, ms: r.ms,
  ...(r.agent !== undefined ? { agent: r.agent } : {}), ipHash: r.ip_hash ?? null });

// source: 'agent' | 'mcp' | 'mcp:head' | 'mcp:client' | 'agent:<name>'.
export async function toolCalls(q, { source = null, tool = null, ok = null, cursor = null, limit = 50 } = {}, actor, opts = {}) {
  need(actor, 'head');
  context(opts);
  const params = [];
  let where = 'TRUE';
  if (source != null) {
    const m = /^(agent|mcp)(?::([\w-]{1,40}))?$/.exec(source);
    if (!m) throw new DomainError('invalid_input', { fields: ['source'] });
    params.push(m[1]);
    where += ` AND tc.source = $${params.length}`;
    if (m[2]) {
      params.push(m[2]);
      where += m[1] === 'mcp' ? ` AND tc.role = $${params.length}` : ` AND ag.agent = $${params.length}`;
    }
  }
  if (tool != null) {
    if (!/^\w{1,60}$/.test(tool)) throw new DomainError('invalid_input', { fields: ['tool'] });
    params.push(tool); where += ` AND tc.tool = $${params.length}`;
  }
  if (ok != null) where += ok ? ' AND tc.ok' : ' AND NOT tc.ok';
  const cur = decodeCursor(cursor);
  if (cur && !/^\d{1,18}$/.test(cur.tie)) throw new DomainError('invalid_input', { fields: ['cursor'] });
  if (cur) { params.push(cur.key, cur.tie); where += ` AND (tc.at, tc.id) < ($${params.length - 1}, $${params.length}::bigint)`; }
  const n = pageSize(limit);
  const rows = await q.query(`SELECT tc.*, ag.agent FROM tool_calls tc
    LEFT JOIN LATERAL (SELECT a.agent FROM agent_runs a WHERE a.turn_id = tc.turn_id AND tc.tool = ANY(a.tools) ORDER BY a.id LIMIT 1) ag ON tc.source = 'agent'
    WHERE ${where} ORDER BY tc.at DESC, tc.id DESC LIMIT ${n + 1}`, params);
  const page = rows.slice(0, n);
  const last = page[page.length - 1];
  return { items: page.map(toolShape), next: rows.length > n ? encodeCursor(last.at, last.id) : null };
}

// ---- costs ----

// 06 §14: by Tashkent day, the paid budget of today, Gemini requests against the free daily limit. days 1…90.
export async function aiCosts(q, { days = 30 } = {}, actor, opts = {}) {
  need(actor, 'head');
  const ctx = context(opts);
  const d = Math.min(90, Math.max(1, Number.isInteger(Number(days)) && Number(days) > 0 ? Number(days) : 30));
  const at = ctx.now();
  const today = tashkentDayStart(at);
  const since = new Date(today.getTime() - (d - 1) * 864e5);
  const DAY = `to_char((at AT TIME ZONE 'Asia/Tashkent')::date, 'YYYY-MM-DD')`;
  const calls = await q.query(`SELECT ${DAY} AS day, provider, model, count(*)::int AS calls, count(*) FILTER (WHERE NOT ok)::int AS failed,
      COALESCE(sum(input_tokens), 0)::bigint AS input, COALESCE(sum(output_tokens), 0)::bigint AS output, COALESCE(sum(cached_tokens), 0)::bigint AS cached,
      COALESCE(sum(cost_usd), 0)::float AS cost FROM ai_calls WHERE at >= $1 GROUP BY 1, 2, 3 ORDER BY 1 DESC, 2, 3`, [since]);
  const runs = await q.query(`SELECT to_char((created_at AT TIME ZONE 'Asia/Tashkent')::date, 'YYYY-MM-DD') AS day, count(*)::int AS runs,
      count(*) FILTER (WHERE fallback)::int AS fallback FROM agent_runs WHERE created_at >= $1 GROUP BY 1`, [since]);
  const reserve = Object.fromEntries(runs.map(r => [r.day, r.runs ? r.fallback / r.runs : 0]));

  const byDay = new Map();
  for (const c of calls) {
    const row = byDay.get(c.day) ?? { day: c.day, calls: 0, failed: 0, input: 0, output: 0, cached: 0, costUsd: 0, byModel: [], fallbackShare: reserve[c.day] ?? 0 };
    row.calls += c.calls; row.failed += c.failed; row.input += Number(c.input); row.output += Number(c.output); row.cached += Number(c.cached); row.costUsd += c.cost;
    row.byModel.push({ provider: c.provider, model: c.model, calls: c.calls, costUsd: c.cost });
    byDay.set(c.day, row);
  }
  const rows = [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1));

  const paid = await q.one(`SELECT COALESCE(sum(cost_usd), 0)::float AS usd FROM ai_calls WHERE provider = 'anthropic' AND at >= $1`, [today]);
  const pacific = pacificDayStart(at);
  const used = await q.query(`SELECT model, count(*)::int AS n FROM ai_calls WHERE provider = 'gemini' AND at >= $1 GROUP BY model`, [pacific]);
  const usedBy = Object.fromEntries(used.map(u => [u.model, u.n]));
  const gemini = Object.entries(MODELS).filter(([, m]) => m.provider === 'gemini' && m.rpd)
    .map(([model, m]) => ({ model, used: usedBy[model] ?? 0, limit: m.rpd }));
  const tier = (await q.one(`SELECT value FROM settings WHERE key = 'ai'`))?.value?.geminiTier ?? 'free';
  return { days: rows, totals: { calls: rows.reduce((s, r) => s + r.calls, 0), costUsd: rows.reduce((s, r) => s + r.costUsd, 0) },
    today: { paidUsd: paid.usd, budgetUsd: dailyBudgetUsd(opts.env ?? process.env), gemini }, geminiTier: tier };
}

// ---- the knowledge base ----

// 12 §8.4: documents' chunks with their text (fewer than 200, the screen shows them in a list), the hash and whether there is a vector.
export async function kbChunks(q, { lang = null, topic = null } = {}, actor, opts = {}) {
  need(actor, 'manager', 'head');
  context(opts);
  if (lang != null && !['ru', 'uz', 'en'].includes(lang)) throw new DomainError('invalid_input', { fields: ['lang'] });
  const params = [];
  let where = 'TRUE';
  if (lang) { params.push(lang); where += ` AND c.lang = $${params.length}`; }
  if (topic) { params.push(String(topic).slice(0, 80)); where += ` AND d.topic = $${params.length}`; }
  const rows = await q.query(`SELECT c.id, c.ord, c.lang, c.heading, c.text, c.content_hash, c.embedding IS NOT NULL AS has_vector, d.slug, d.title, d.topic, d.path, d.updated_at
    FROM kb_chunks c JOIN kb_documents d ON d.id = c.document_id WHERE ${where} ORDER BY d.topic, d.slug, c.lang, c.ord`, params);
  const topics = await q.query('SELECT DISTINCT topic FROM kb_documents ORDER BY topic');
  return { items: rows.map(r => ({ id: Number(r.id), lang: r.lang, file: r.path, slug: r.slug, title: r.title, topic: r.topic, heading: r.heading, length: r.text.length,
    text: r.text, hash: r.content_hash.slice(0, 12), indexedAt: r.updated_at, hasVector: r.has_vector })), topics: topics.map(t => t.topic) };
}

const words = s => new Set(String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length >= 4));
const similar = (a, b) => {
  if (!a.size || !b.size) return false;
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  return both / (a.size + b.size - both) >= 0.5;
};

// 09 §8: the questions the consultant honestly refused, grouped by the words they share. Without clients. Refusals with the vectors
// unavailable (keyword_only) are counted apart: that is not a gap of the base.
export async function kbUnanswered(q, { days = 30 } = {}, actor, opts = {}) {
  need(actor, 'manager', 'head');
  const ctx = context(opts);
  const d = Math.min(90, Math.max(1, Number.isInteger(Number(days)) && Number(days) > 0 ? Number(days) : 30));
  const since = new Date(ctx.now().getTime() - d * 864e5);
  const rows = await q.query(`SELECT at, lang, query, mode FROM kb_queries WHERE answered = false AND at >= $1 ORDER BY at DESC LIMIT 1000`, [since]);
  const groups = [];
  for (const r of rows.filter(x => x.mode !== 'keyword_only')) {
    const w = words(r.query);
    const g = groups.find(x => x.lang === r.lang && similar(x.words, w));
    if (g) { g.count++; for (const x of w) g.words.add(x); } else groups.push({ query: r.query, lang: r.lang, count: 1, lastAt: r.at, words: w });
  }
  groups.sort((a, b) => b.count - a.count || (a.lastAt < b.lastAt ? 1 : -1));
  return { groups: groups.map(({ words: _w, ...g }) => g), keywordOnly: rows.filter(x => x.mode === 'keyword_only').length, days: d };
}

// 09 §4: the same as `npm run kb:index`, right in the request: only changed files are re-embedded (the hash). Without the Gemini key the
// button is off (feature_disabled).
export async function reindexKb(db, { ai, root, env = process.env, log = { log() {}, warn() {} } }, actor, opts = {}) {
  need(actor, 'head');
  context(opts);
  if (!ai || !env.GEMINI_API_KEY) throw new DomainError('feature_disabled');
  const r = await ingest({ db, ai, root, log });
  return { changed: r.embedded, deleted: r.removed, total: r.chunks, documents: r.documents, partial: r.partial, ms: r.ms };
}
