// npm run db:migrate [-- --yes] — applies new migrations to DATABASE_URL (02 §6); without it — to the local PGlite.
import { openTarget } from './dbTarget.js';
import { migrate } from '../server/db/migrate.js';

const db = openTarget();
try {
  const ran = await migrate(await db.ready());
  console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Up to date.');
} finally { await db.close(); }
