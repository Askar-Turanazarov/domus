// Test helpers: the MCP server on port 0 with a test token over a PGlite base in memory, JSON-RPC over fetch.
// Statuses as in apartments.json (test/support/db.js mirrorFileStatuses); the call log is the base's tool_calls.
import fs from 'node:fs';
import { createHttpServer } from '../../server/mcp/index.js';
import { FILES, dbContext } from '../../server/tools/index.js';
import { legacyStore } from '../../server/db/legacy.js';
import { createTestDb, mirrorFileStatuses } from '../support/db.js';

export const TOKEN = 'test-token-'.padEnd(40, 'x');
export const list = JSON.parse(fs.readFileSync(FILES.apartments, 'utf8')).apartments;

// over — parts of the tools' context to replace (apartments path, statuses(), logCall()).
export async function start(over = {}) {
  const db = await createTestDb();
  await mirrorFileStatuses(db);
  const store = legacyStore(db);
  const server = createHttpServer({ token: TOKEN, ctx: { ...dbContext(store), ...over } });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const rpc = (method, params, token = TOKEN) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const call = async (name, args) => (await (await rpc('tools/call', { name, arguments: args })).json()).result;
  // oldest first
  const log = async () => (await store.listCalls(10000)).reverse();
  const close = async () => { server.close(); await db.close(); };
  return { server, url, rpc, call, log, db, store, close };
}
