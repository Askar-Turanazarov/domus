// npm run seed -- --base [--yes] — apartments and default settings (02 §8). Safe to repeat.
import { openTarget } from './dbTarget.js';
import { migrate } from '../server/db/migrate.js';
import { seedBase } from '../server/db/seed/base.js';

const args = process.argv.slice(2);
if (!args.includes('--base')) {
  console.error('Usage: npm run seed -- --base [--yes]');
  process.exit(1);
}
const db = openTarget(args);
try {
  const ready = await db.ready();
  if (db.kind === 'pglite') await migrate(ready);
  const r = await seedBase(ready);
  const n = await ready.one('SELECT (SELECT count(*) FROM apartments) AS apartments, (SELECT count(*) FROM settings) AS settings');
  console.log(`Apartments: ${n.apartments} (changed ${r.apartments}), settings: ${n.settings} (added ${r.settings}).`);
} finally { await db.close(); }
