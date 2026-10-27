// For scripts that write to the base (16 §5): say which base it is, and refuse production without --yes.
import { loadEnv } from '../server/env.js';
import { createDb } from '../server/db/index.js';

export function openTarget(args = process.argv.slice(2)) {
  loadEnv();
  const url = process.env.DATABASE_URL;
  const env = process.env.VERCEL_ENV || process.env.NODE_ENV || 'development';
  const host = url ? new URL(url).hostname : `PGlite ${process.env.PGLITE_DIR || '.pglite/'}`;
  console.log(`Base: ${host} (${env})`);
  if (url && (env === 'production' || process.env.DB_BRANCH === 'main') && !args.includes('--yes')) {
    console.error('This is the production base: add --yes to go on.');
    process.exit(1);
  }
  return createDb({ url });
}
