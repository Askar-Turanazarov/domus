// npm run test:neon wipes every business table of the base it runs on (15 §4 step 1). So it never runs on the production
// base: the test URL must not point at the same Neon endpoint as any DATABASE_URL we know of (the environment, .env,
// .env.local, .env.neon). The endpoint is the host without «-pooler»; branches of one project have different endpoints.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const URL_KEYS = ['DATABASE_URL', 'DATABASE_URL_UNPOOLED', 'POSTGRES_URL', 'POSTGRES_URL_NON_POOLING', 'POSTGRES_PRISMA_URL'];
const FILES = ['.env', '.env.local', '.env.neon', '.env.production', '.env.development'];

export const endpointOf = url => {
  try { return new URL(url).hostname.replace('-pooler', '').toLowerCase(); } catch { return null; }
};

// Every database URL written in the env files and the environment. → Set of endpoints.
export function knownEndpoints(env = process.env, root = path.join(import.meta.dirname, '..', '..')) {
  const found = new Set();
  const add = v => { const e = v && endpointOf(String(v).replace(/^(['"])(.*)\1$/, '$2')); if (e) found.add(e); };
  for (const k of URL_KEYS) add(env[k]);
  for (const file of FILES) {
    let text = '';
    try { text = readFileSync(path.join(root, file), 'utf8'); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && URL_KEYS.includes(m[1])) add(m[2]);
    }
  }
  return found;
}

// → { ok: true, endpoint } | { ok: false, reason }.
export function checkTestUrl(testUrl, env = process.env, root) {
  const endpoint = endpointOf(testUrl);
  if (!testUrl) return { ok: false, reason: 'not_set' };
  if (!endpoint || !/^postgres(ql)?:\/\//.test(testUrl)) return { ok: false, reason: 'not_a_postgres_url' };
  if (knownEndpoints(env, root).has(endpoint)) return { ok: false, reason: 'is_a_known_base', endpoint };
  return { ok: true, endpoint };
}
