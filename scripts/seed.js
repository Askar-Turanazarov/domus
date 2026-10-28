// npm run seed -- --base [--yes] — apartments and default settings (02 §8). Safe to repeat.
// npm run seed -- --demo [--now 2026-11-02T09:00+05:00] [--yes] — wipes the business data and pours in 30 days of history up to --now (default: now).
import { openTarget } from './dbTarget.js';
import { migrate } from '../server/db/migrate.js';
import { seedBase } from '../server/db/seed/base.js';
import { seedDemo } from '../server/db/seed/demo.js';

const args = process.argv.slice(2);
const demo = args.includes('--demo');
if (!demo && !args.includes('--base')) {
  console.error('Usage: npm run seed -- --base [--yes]\n       npm run seed -- --demo [--now 2026-11-02T09:00+05:00] [--yes]');
  process.exit(1);
}
const at = args.includes('--now') ? new Date(args[args.indexOf('--now') + 1]) : new Date();
if (Number.isNaN(at.getTime())) {
  console.error('--now needs a date, like 2026-11-02T09:00+05:00');
  process.exit(1);
}
const db = openTarget(args);
try {
  const ready = await db.ready();
  if (db.kind === 'pglite') await migrate(ready);
  if (demo) {
    const s = await seedDemo(ready, { now: at });
    console.log(`Demo history up to ${at.toISOString()}:`, JSON.stringify(s));
  } else {
    const r = await seedBase(ready);
    const n = await ready.one('SELECT (SELECT count(*) FROM apartments) AS apartments, (SELECT count(*) FROM settings) AS settings');
    console.log(`Apartments: ${n.apartments} (changed ${r.apartments}), settings: ${n.settings} (added ${r.settings}).`);
  }
} finally { await db.close(); }
