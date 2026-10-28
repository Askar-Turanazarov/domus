// npm run client:forget -- --phone "+998 90 123 45 67" (14 §10.4, C): a client asked to erase the data — the head runs this.
// Name → «Удалён», phone and Telegram → null, the client's messages → «[удалено]»; bookings and payments stay; client.forgotten.
// Production base: add --yes (scripts/dbTarget.js).
import { openTarget } from './dbTarget.js';
import { migrate } from '../server/db/migrate.js';
import { forgetClients } from '../server/core/clients.js';

const args = process.argv.slice(2);
const i = args.indexOf('--phone');
const phone = i >= 0 ? args[i + 1] : undefined;
if (!phone) { console.error('client:forget -- --phone "+998 90 123 45 67" [--yes]'); process.exit(1); }

const db = openTarget(args);
try {
  const ready = await db.ready();
  if (db.kind === 'pglite') await migrate(ready);
  const n = await forgetClients(ready, { phone }, { type: 'system', channel: 'script' });
  console.log(n ? `Забыто карточек / Cards erased: ${n}` : 'Карточек с этим номером нет / No cards with this phone');
} catch (e) {
  console.error(e.code === 'phone_invalid' ? 'Неверный номер / Invalid phone' : e.message);
  process.exitCode = 1;
} finally { await db.close(); }
