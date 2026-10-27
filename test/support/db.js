// Test base (15 §2): PGlite in memory with all migrations and the base seed (92 apartments, default settings).
import { createDb } from '../../server/db/index.js';
import { seedBase } from '../../server/db/seed/base.js';

export async function createTestDb() {
  const db = createDb({ url: '', dir: 'memory://' });
  await db.ready();
  return db;
}

// Every table but schema_migrations emptied, numbering from the start, then the base seed again.
export async function resetDb(db) {
  const tables = (await db.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'")).map(r => r.tablename);
  await db.exec(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE;
    ALTER SEQUENCE booking_no_seq RESTART; ALTER SEQUENCE order_no_seq RESTART; ALTER SEQUENCE click_prepare_seq RESTART;`);
  await seedBase(db);
}

export { seedBase };

// The Domus tests expect apartments.json's statuses (56 free, 17 booked, 19 sold): sold → sold_at, booked → an active
// paid booking far ahead. The demo seed (02 §8.3) does the same with real history.
export async function mirrorFileStatuses(db, now = new Date()) {
  const { readApartments } = await import('../../server/db/seed/base.js');
  const far = new Date(now.getTime() + 365 * 864e5);
  await db.tx(async q => {
    const c = await q.one("INSERT INTO clients (name, first_channel, created_at, updated_at) VALUES ('Тест', 'web', $1, $1) RETURNING id", [now]);
    for (const a of readApartments()) {
      if (a.status === 'sold') await q.query('UPDATE apartments SET sold_at = $1 WHERE no = $2', [now, a.no]);
      if (a.status === 'booked') await q.query(
        `INSERT INTO bookings (apartment_no, client_id, status, channel, created_by, expires_at, held_at, booked_at, deposit_amount, price_at_booking, updated_at)
         VALUES ($1, $2, 'booked', 'web', '{"type":"system"}', $3, $4, $4, 10000000, $5, $4)`, [a.no, c.id, far, now, a.price]);
    }
  });
}
