// npm run kb:index [-- --yes] — kb/**/*.md → the base with vectors (09 §4). Run by hand after the texts change; the
// Vercel build does not run it. Without GEMINI_API_KEY the chunks are saved without vectors.
import path from 'node:path';
import { openTarget } from './dbTarget.js';
import { migrate } from '../server/db/migrate.js';
import { createAi } from '../server/ai/index.js';
import { ingest } from '../server/kb/ingest.js';

const args = process.argv.slice(2);
const db = openTarget(args);
try {
  const ready = await db.ready();
  if (db.kind === 'pglite') await migrate(ready);
  const ai = process.env.GEMINI_API_KEY ? createAi({ db: ready }) : null;
  const r = await ingest({ db: ready, ai, root: path.join(import.meta.dirname, '..', 'kb') });
  console.log(`Documents: ${r.documents}, chunks: ${r.chunks}, new vectors: ${r.embedded}, unchanged files: ${r.skipped}, removed: ${r.removed}, ${r.ms} ms.`);
  if (r.partial) console.warn('Some chunks have no vectors: search works by words only. Run again with a working GEMINI_API_KEY.');
} finally { await db.close(); }
