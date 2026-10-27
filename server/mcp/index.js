// MCP server «Chinor Park» over Streamable HTTP: on the site as POST /mcp (server.js, also on Vercel),
// or on its own at http://127.0.0.1:3001/mcp (node server/mcp/index.js, for development).
// Every request needs `Authorization: Bearer <MCP_TOKEN>` (MCP_TOKEN from the project's .env); otherwise 401.
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools, dbContext } from '../tools/index.js';
import { createDb } from '../db/index.js';
import { legacyStore } from '../db/legacy.js';
import { loadEnv } from '../env.js';
import { logTexts, ruText } from '../tools/logText.js';

export { dbContext };

const MAX_BODY = 1 << 20;   // 1 MB of JSON-RPC is plenty
export const MIN_TOKEN = 32;

// Bearer token, compared in constant time. Pure.
export function checkToken(header, token) {
  const got = Buffer.from(String(header || '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(token);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
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

// ctx — the tools' context (server/tools/index.js dbContext over the site's storage).
export function createHttpServer({ token, ctx }) {
  if (!token || token.length < MIN_TOKEN) throw new Error(`MCP_TOKEN is missing or shorter than ${MIN_TOKEN} characters (see .env)`);
  return http.createServer((req, res) => handleMcp(req, res, { token, ctx }).catch(e => {
    // never let one request bring the process down
    console.error('mcp request failed:', e.code || e.message);
    if (!res.headersSent) send(res, 500, { error: 'internal' }); else res.destroy();
  }));
}

// One request. Stateless: a fresh MCP server and transport per request, plain JSON answers (no SSE stream to keep
// open) — so it also runs as a Vercel function. parsed — the body already read by the site (express.json), if any.
export async function handleMcp(req, res, { token, ctx, parsed }) {
  if (req.url.split('?')[0] !== '/mcp') return send(res, 404, { error: 'not_found' });
  if (!checkToken(req.headers.authorization, token)) {
    await ctx.logCall({ type: 'denied', reason: req.headers.authorization ? 'bad_token' : 'no_token' });
    return send(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  let body = parsed;
  if (body === undefined) {
    try { body = await readBody(req); } catch (e) {
      if (!e.status) return res.destroy();   // the client went away mid-body
      return send(res, e.status, { error: e.status === 413 ? 'too_large' : 'bad_json' });
    }
  } else if (JSON.stringify(body).length > MAX_BODY) return send(res, 413, { error: 'too_large' });
  const server = new McpServer({ name: 'chinor-park', version: '0.1.0' });
  const seen = { logged: false };
  registerTools(server, ctx, seen);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  const t0 = Date.now();
  await transport.handleRequest(req, res, body);
  // A tools/call the SDK refused before any tool ran (bad or unknown arguments, unknown tool) is logged too, with
  // field names only — never values; stamped with the request's start, so the log page keeps the real order.
  if (body?.method === 'tools/call' && !seen.logged) {
    const { name, arguments: a } = body.params || {};
    await ctx.logCall({ at: new Date(t0).toISOString(), type: 'call', tool: String(name).slice(0, 60), ok: false, ms: Date.now() - t0,
      error: 'invalid_input', args: { fields: Object.keys(a && typeof a === 'object' ? a : {}).slice(0, 20) }, msg: ruText('badParams'), msgs: logTexts('badParams') });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  loadEnv();
  // the site's base: Neon with DATABASE_URL, the local PGlite (.pglite/) otherwise
  const store = legacyStore(createDb());
  const port = Number(process.env.MCP_PORT) || 3001;
  const host = '127.0.0.1';
  createHttpServer({ token: process.env.MCP_TOKEN, ctx: dbContext(store) }).listen(port, host, () => console.log(`MCP «Chinor Park»: http://${host}:${port}/mcp`));
}
