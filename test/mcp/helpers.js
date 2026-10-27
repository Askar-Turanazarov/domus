// The MCP server on port 0 over a PGlite base in memory, the real registry, two role tokens; JSON-RPC over fetch.
import { createHttpServer } from '../../server/mcp/index.js';
import { createTools } from '../../server/tools/registry.js';
import { createTestDb, resetDb } from '../support/db.js';

export const CLIENT_TOKEN = 'client-token-'.padEnd(40, 'c');
export const HEAD_TOKEN = 'head-token-'.padEnd(40, 'h');
export const ENV = { MCP_CLIENT_TOKEN: CLIENT_TOKEN, MCP_HEAD_TOKEN: HEAD_TOKEN, LOG_SALT: 'test-salt', TELEGRAM_STAFF_CHAT_ID: '-1',
  LINK_SECRET: 'test-secret', PUBLIC_URL: 'https://x.test' };

export async function start({ env = {} } = {}) {
  const db = await createTestDb();
  const full = { ...ENV, ...env };
  const server = createHttpServer({ db, tools: createTools({ db, env: full, log: { error() {}, warn() {}, info() {} } }), env: full });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const rpc = (method, params, token = HEAD_TOKEN, extra = {}) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    ...extra
  });
  const call = async (name, args, token = HEAD_TOKEN) => (await (await rpc('tools/call', { name, arguments: args }, token)).json()).result;
  const names = async token => (await (await rpc('tools/list', {}, token)).json()).result.tools.map(t => t.name);
  const reset = () => resetDb(db);
  const close = async () => { server.close(); await db.close(); };
  return { server, url, rpc, call, names, db, env: full, reset, close };
}
