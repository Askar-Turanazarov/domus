// Pre-download the on-demand texture sets of public/textures/library.json (ambientCG, CC0) into public/textures/lib/,
// or with --blob into Vercel Blob (BLOB_READ_WRITE_TOKEN, or BLOB_STORE_ID + VERCEL_OIDC_TOKEN, from .env.local / .env —
// e.g. after `vercel env pull`).
// Usage: npm run textures [-- --kind floor|wall|rough|furniture] [-- --id oakPlanks] [-- --blob]
// The facade and site sets are bundled in the project (public/textures/sets/), nothing to download for them.
import fs from 'node:fs';
import path from 'node:path';
import { fetchSet, libraryStatus } from '../server/textureFetch.js';

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : null;
}

if (process.argv.includes('--blob')) {
  for (const f of ['.env.local', '.env']) {
    const p = path.join(import.meta.dirname, '..', f);
    if (fs.existsSync(p)) process.loadEnvFile(p);
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) {
    console.error('No Blob store: BLOB_READ_WRITE_TOKEN or BLOB_STORE_ID is not set (run `vercel env pull` first).');
    process.exit(1);
  }
} else {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_STORE_ID;
}

(async () => {
  const kind = arg('kind'), id = arg('id');
  const todo = (await libraryStatus())
    .filter(e => !e.bundled && !e.available && (!kind || e.kind === kind) && (!id || e.id === id));
  if (!todo.length) return console.log('Nothing to download: all sets are there.');
  const mb = todo.reduce((s, e) => s + (e.mb || 5), 0);
  console.log(`${todo.length} set(s), about ${Math.round(mb)} MB of zips from ambientcg.com`);
  let failed = 0;
  for (const e of todo) {
    try {
      await fetchSet(e.id, { log: m => console.log('  ' + m) });
    } catch (err) {
      failed++;
      console.error(`  ${e.id}: ${err.message}`);
    }
  }
  console.log(failed ? `Done, ${failed} failed.` : 'Done.');
  process.exitCode = failed ? 1 : 0;
})();
