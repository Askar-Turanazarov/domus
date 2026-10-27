// npm run jobs:run [-- --daily] — sweep expired holds and bookings and run due jobs now (04 §5); --daily — the whole
// daily Cron. Against DATABASE_URL (node --env-file=.env.neon …) or the local PGlite. For when QStash is off.
import { openTarget } from './dbTarget.js';
import { sweepDue } from '../server/core/bookings.js';
import { runJobs, daily } from '../server/events/runner.js';

const db = openTarget();
try {
  const base = await db.ready();
  const r = process.argv.includes('--daily')
    ? await daily(base)
    : { swept: (await sweepDue(base, { limit: 500 })).length, ...(await runJobs(base, { limit: 200 })) };
  console.log(JSON.stringify(r));
} finally { await db.close(); }
