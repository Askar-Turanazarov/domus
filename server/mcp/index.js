// MCP server «chinor-park» over Streamable HTTP (08 §7): the registry's tools for external clients (Claude Desktop).
// On the site: POST /mcp (server.js, also on Vercel); on its own for development: node server/mcp/index.js (port 3001).
// Two tokens: MCP_CLIENT_TOKEN → the demo client (D-24), MCP_HEAD_TOKEN → the head. The tool list is made for the role,
// so the client token never sees the head's tools. Changing tools are two-step: a draft with confirmToken, then the same call with it.
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { now } from '../core/clock.js';
import { limit, MINUTE } from '../http/common.js';

const MAX_BODY = 1 << 20;   // 1 MB of JSON-RPC is plenty
export const MIN_TOKEN = 32;
export const TOKEN_LIMIT = 60;      // calls a minute per token (08 §7.2)
export const IP_LIMIT = 20;         // refused tries a minute per address

// Bearer token, compared in constant time. Pure.
export function checkToken(header, token) {
  const got = Buffer.from(String(header || '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(String(token ?? ''));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// The tokens that may be used: at least 32 characters and different from each other (14 §8); otherwise that role is off.
export function mcpTokens(env = process.env) {
  const ok = t => (typeof t === 'string' && t.length >= MIN_TOKEN ? t : null);
  const client = ok(env.MCP_CLIENT_TOKEN);
  const head = ok(env.MCP_HEAD_TOKEN);
  if (client && client === head) return { client: null, head: null };
  return { client, head };
}

// 08 §7.3. Both comparisons are always made, so the time does not tell which token matched.
export function actorOf(header, tokens, env = process.env) {
  const isClient = tokens.client ? checkToken(header, tokens.client) : false;
  const isHead = tokens.head ? checkToken(header, tokens.head) : false;
  if (isHead) return { type: 'mcp', id: null, role: 'head', channel: 'mcp' };
  if (isClient) return { type: 'mcp', id: env.MCP_CLIENT_ID || null, role: 'client', channel: 'mcp' };
  return null;
}

const send = (res, code, body, headers = {}) =>
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(body));

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    if ((size += c.length) > MAX_BODY) throw Object.assign(new Error('too large'), { status: 413 });
    chunks.push(c);
  }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined; } catch {
    throw Object.assign(new Error('bad json'), { status: 400 });
  }
}

const ipHash = (req, env) => crypto.createHash('sha256').update(`${req.ip ?? req.socket?.remoteAddress ?? ''}${env.LOG_SALT ?? ''}`)
  .digest('hex').slice(0, 16);

// 08 §9: a refusal before any tool — no tool, the reason in error, the address only as a hash.
async function logRefusal(db, req, env, error) {
  try {
    await db.query(`INSERT INTO tool_calls (at, source, tool, role, ok, error, ms, ip_hash) VALUES ($1, 'mcp', NULL, NULL, false, $2, 0, $3)`,
      [now(), error, ipHash(req, env)]);
  } catch (e) { console.error('tool_calls write failed:', e.code || e.message); }
}

const TEXT_MAX = 6000;
const text = s => ({ type: 'text', text: s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX)}…` : s });

// The registry's answer → an MCP result (08 §4 step 7): structuredContent + a short text; a draft says what to do next.
export function toMcp(tool, res) {
  if (!res.ok) {
    return { isError: true, content: [text(res.fields ? `${res.message} (${res.fields.join(', ')})` : res.message)] };
  }
  if (res.pending) {
    const structuredContent = { needsConfirmation: true, confirmToken: res.confirmToken, preview: res.preview, expiresAt: res.expiresAt };
    return { structuredContent, content: [text(`Требуется подтверждение: «${tool.title.ru}». Условия: ${JSON.stringify(res.preview)}. `
      + 'Покажите условия человеку и только после его явного согласия повторите вызов с теми же аргументами и confirmToken.')] };
  }
  const body = JSON.stringify(res.out);
  return { structuredContent: res.out, content: [text(res.status === 'executed' ? `Готово: ${body}` : body)] };
}

const CONFIRM_HINT = ' Always show the preview to the user and call again with confirmToken only after the user explicitly agrees.';

// The tools of this role from the registry, as the SDK wants them. seen.logged — a tool ran (else the SDK refused the call).
function registerTools(server, { tools, actor, seen, core }) {
  for (const tool of tools.list({ actor, source: 'mcp' })) {
    const config = {
      title: tool.title.en,
      description: tool.description + (tool.mutates ? CONFIRM_HINT : ''),
      inputSchema: tool.mutates ? tool.input.extend({ confirmToken: z.string().min(8).max(200).optional() }) : tool.input
    };
    if (!tool.mutates) config.outputSchema = tool.output;           // a draft has another shape than the result
    server.registerTool(tool.name, config, async args => {
      seen.logged = true;
      return toMcp(tool, await tools.run(tool.name, args, { actor, source: 'mcp', lang: 'ru', onCommit: core.onCommit, render: core.render }));
    });
  }
}

// One request. Stateless: a fresh MCP server and transport per request, plain JSON answers (no SSE stream to keep
// open) — so it also runs as a Vercel function. parsed — the body already read by the site (express.json), if any.
// ctx — { db, tools, env, core }; core — { onCommit, render } of the core calls: after COMMIT the notifications are delivered.
export async function handleMcp(req, res, { db, tools, env = process.env, parsed, core = {} }) {
  if (req.url.split('?')[0] !== '/mcp') return send(res, 404, { error: 'not_found' });
  if (req.method === 'OPTIONS') return res.writeHead(204).end();                                   // mcp-remote may ask (14 §5)
  const tokens = mcpTokens(env);
  if (!tokens.client && !tokens.head) return send(res, 503, { error: 'mcp_disabled' });
  const actor = actorOf(req.headers.authorization, tokens, env);
  try {
    if (!actor) {
      await limit(db, `mcp:ip:${ipHash(req, env)}`, IP_LIMIT, MINUTE);
      await logRefusal(db, req, env, req.headers.authorization ? 'bad_token' : 'no_token');
      return send(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    }
    await limit(db, `mcp:token:${actor.role}`, TOKEN_LIMIT, MINUTE);
  } catch (e) {
    if (e.code !== 'rate_limited') throw e;
    return send(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(e.vars.retryAfter) });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  let body = parsed;
  if (body === undefined) {
    try { body = await readBody(req); } catch (e) {
      if (!e.status) return res.destroy();   // the client went away mid-body
      return send(res, e.status, { error: e.status === 413 ? 'too_large' : 'bad_json' });
    }
  } else if (JSON.stringify(body).length > MAX_BODY) return send(res, 413, { error: 'too_large' });
  const server = new McpServer({ name: 'chinor-park', version: '0.2.0' });
  const seen = { logged: false };
  registerTools(server, { tools, actor, seen, core });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
  // A tools/call the SDK refused before any tool ran (bad or unknown arguments, unknown tool): logged with field names only.
  if (body?.method === 'tools/call' && !seen.logged) {
    const { name, arguments: a } = body.params || {};
    try {
      await db.query(`INSERT INTO tool_calls (at, source, tool, role, args, ok, error, ms) VALUES ($1, 'mcp', $2, $3, $4, false, 'invalid_input', 0)`,
        [now(), String(name).slice(0, 60), actor.role, JSON.stringify({ fields: Object.keys(a && typeof a === 'object' ? a : {}).slice(0, 20) })]);
    } catch (e) { console.error('tool_calls write failed:', e.code || e.message); }
  }
}

export function createHttpServer({ db, tools, env = process.env, core = {} }) {
  return http.createServer((req, res) => handleMcp(req, res, { db, tools, env, core }).catch(e => {
    // never let one request bring the process down
    console.error('mcp request failed:', e.code || e.message);
    if (!res.headersSent) send(res, 500, { error: 'internal' }); else res.destroy();
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { loadEnv } = await import('../env.js');
  const { createDb } = await import('../db/index.js');
  const { migrate } = await import('../db/migrate.js');
  const { createTools } = await import('../tools/registry.js');
  loadEnv();
  const raw = createDb();
  const db = await raw.ready();
  if (raw.kind === 'pglite') await migrate(db);
  const port = Number(process.env.MCP_PORT) || 3001;
  const host = '127.0.0.1';
  createHttpServer({ db, tools: createTools({ db, env: process.env }), env: process.env })
    .listen(port, host, () => console.log(`MCP «chinor-park»: http://${host}:${port}/mcp`));
}
