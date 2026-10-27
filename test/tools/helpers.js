// Test helpers: the MCP server on port 0 with a test token, JSON-RPC over fetch.
// The call log always goes to a temporary file, never to the real mcp-calls.jsonl.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHttpServer } from '../../server/mcp/index.js';
import { FILES } from '../../server/tools/index.js';

export const TOKEN = 'test-token-'.padEnd(40, 'x');
export const list = JSON.parse(fs.readFileSync(FILES.apartments, 'utf8')).apartments;

export async function start(files = {}) {
  const calls = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-calls-')), 'mcp-calls.jsonl');
  const all = { ...FILES, calls, ...files };
  const server = createHttpServer({ token: TOKEN, files: all });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const rpc = (method, params, token = TOKEN) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const call = async (name, args) => (await (await rpc('tools/call', { name, arguments: args })).json()).result;
  const log = () => (fs.existsSync(all.calls) ? fs.readFileSync(all.calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
  return { server, url, rpc, call, log, files: all };
}
