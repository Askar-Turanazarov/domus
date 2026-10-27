// .env.local (`vercel env pull`) and .env (KEY=value lines) without extra dependencies; real environment variables win.
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function loadEnv(root = path.join(import.meta.dirname, '..')) {
  for (const file of ['.env.local', '.env']) {
    try {
      for (const line of readFileSync(path.join(root, file), 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
      }
    } catch { /* no file */ }
  }
}
