// The MCP call log in a file (mcp-calls.jsonl): one JSON line per tool call or refused request.
// Never holds the token, a name or a phone; a failed write is only reported and never breaks a tool.
import fs from 'node:fs/promises';

const MAX_BYTES = 1 << 20;   // past 1 MB the log keeps its last KEEP lines
const KEEP = 1000;

// One queue per file: appends never interleave, the trim never races a write.
const queues = new Map();

function logEvent(file, event) {
  if (!file) return Promise.resolve();
  const run = (queues.get(file) || Promise.resolve()).then(async () => {
    await fs.appendFile(file, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
    const { size } = await fs.stat(file);
    if (size > MAX_BYTES) {
      const lines = (await fs.readFile(file, 'utf8')).trim().split('\n').slice(-KEEP);
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, lines.join('\n') + '\n');
      await fs.rename(tmp, file);
    }
  }).catch(e => console.error('call log write failed:', e.code || e.name));
  queues.set(file, run);
  return run;
}

// The last `limit` events, newest first; no file yet = no calls, a half-written or broken line is skipped.
// By time, not by line: a refused call is written a moment after its answer.
async function readCalls(file, limit = 200) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const events = [];
  for (const line of text.split('\n')) {
    try { if (line.trim()) events.push(JSON.parse(line)); } catch { /* skipped */ }
  }
  events.sort((x, y) => String(x.at).localeCompare(String(y.at)));
  return events.slice(-limit).reverse();
}

export { logEvent, readCalls, KEEP };
