// Migrations (02 §6): server/db/migrations/NNN_name.sql in order, each in its own transaction under
// pg_advisory_xact_lock(727001) — two parallel runs never apply one file twice. Old files are never edited.
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(import.meta.dirname, 'migrations');
const LOCK = 727001;

// ['001_core', '002_payments', …] — what the code expects.
export const migrationFiles = () => fs.readdirSync(DIR).filter(f => /^\d{3}_\w+\.sql$/.test(f)).sort().map(f => f.slice(0, -4));

async function applied(q) {
  const t = await q.one("SELECT to_regclass('schema_migrations') AS t");
  return t.t ? (await q.query('SELECT version FROM schema_migrations')).map(r => r.version) : [];
}

// Versions the base still lacks (for /api/health: migration_needed).
export async function pendingMigrations(db) {
  const done = new Set(await applied(db));
  return migrationFiles().filter(v => !done.has(v));
}

// Applies what is missing; returns the versions applied now.
export async function migrate(db, { now = () => new Date() } = {}) {
  const ran = [];
  for (const version of migrationFiles()) {
    const did = await db.tx(async q => {
      await q.query('SELECT pg_advisory_xact_lock($1)', [LOCK]);
      if ((await applied(q)).includes(version)) return false;
      await q.exec(fs.readFileSync(path.join(DIR, version + '.sql'), 'utf8'));
      await q.query('INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)', [version, now()]);
      return true;
    });
    if (did) ran.push(version);
  }
  return ran;
}
