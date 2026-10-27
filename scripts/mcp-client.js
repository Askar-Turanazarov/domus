// npm run mcp:client [-- --yes] — the demo client behind MCP_CLIENT_TOKEN (D-24, 08 §5): finds or creates «MCP-клиент» in the
// base and prints its id for MCP_CLIENT_ID (the local .env, or the Vercel variables for Neon). Does not touch the environment itself.
import { openTarget } from './dbTarget.js';
import { migrate } from '../server/db/migrate.js';
import { now } from '../server/core/clock.js';

const NAME = 'MCP-клиент';
const PHONE = '+998900000001';   // a demo number: the hold needs a phone (08 §3.1, MCP), nothing is sent to it

const db = openTarget(process.argv.slice(2));
try {
  const ready = await db.ready();
  if (db.kind === 'pglite') await migrate(ready);
  let c = await ready.one(`SELECT id FROM clients WHERE name = $1 AND first_channel = 'mcp' AND merged_into IS NULL ORDER BY created_at LIMIT 1`, [NAME]);
  if (!c) {
    c = await ready.one(`INSERT INTO clients (name, phone, phone_verified, lang, channels, first_channel, created_at, updated_at)
      VALUES ($1, $2, false, 'ru', ARRAY['mcp'], 'mcp', $3, $3) RETURNING id`, [NAME, PHONE, now()]);
    console.log('Demo client created.');
  }
  console.log(`MCP_CLIENT_ID=${c.id}`);
} finally { await db.close(); }
