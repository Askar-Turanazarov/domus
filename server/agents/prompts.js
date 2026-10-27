// The system prompts (07 §7.1): server/agents/prompts/<agent>.md in English, _common.md in front of every sub-agent's.
// Read once; the version is the first 8 hex of the file's sha256 (shown in the agent journal, §16.2).
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const DIR = new URL('./prompts/', import.meta.url);
const cache = new Map();

function file(name) {
  if (!cache.has(name)) {
    const url = new URL(`${name}.md`, DIR);
    const text = existsSync(url) ? readFileSync(url, 'utf8').trim() : null;
    if (text == null) throw new Error(`no prompt ${name}.md`);
    cache.set(name, { text, version: createHash('sha256').update(text).digest('hex').slice(0, 8) });
  }
  return cache.get(name);
}

// → { text, version }; common: false for the router (it answers JSON, not the client).
export function prompt(name, { common = true } = {}) {
  const own = file(name);
  if (!common) return own;
  const c = file('_common');
  return { text: `${c.text}\n\n${own.text}`, version: own.version, commonVersion: c.version };
}
