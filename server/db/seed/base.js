// seed --base (02 §8): the 92 apartments from apartments.json and the default settings. Safe to repeat:
// apartments are upserted (a row changes only if its data did), settings already in the base are kept.
// The file's status field does not go into the table (D-15): bookings and sales come from the demo seed.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '../../core/defaults.js';

const FILE = path.join(import.meta.dirname, '..', '..', '..', 'apartments.json');

export const readApartments = (file = FILE) => JSON.parse(fs.readFileSync(file, 'utf8')).apartments;

// → { apartments: changed rows, settings: added keys }
export async function seedBase(db, { now = new Date(), file } = {}) {
  return db.tx(async q => {
    let apartments = 0, settings = 0;
    for (const a of readApartments(file)) {
      const r = await q.query(
        `INSERT INTO apartments (no, building, floor, rooms, area, price, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (no) DO UPDATE SET building = EXCLUDED.building, floor = EXCLUDED.floor, rooms = EXCLUDED.rooms,
           area = EXCLUDED.area, price = EXCLUDED.price, updated_at = EXCLUDED.updated_at, version = apartments.version + 1
         WHERE (apartments.building, apartments.floor, apartments.rooms, apartments.area, apartments.price)
           IS DISTINCT FROM (EXCLUDED.building, EXCLUDED.floor, EXCLUDED.rooms, EXCLUDED.area, EXCLUDED.price)
         RETURNING no`,
        [a.no, a.building, a.floor, a.rooms, a.area, a.price, now]);
      apartments += r.length;
    }
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      const r = await q.query(
        'INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING RETURNING key',
        [key, JSON.stringify(value), now]);
      settings += r.length;
    }
    return { apartments, settings };
  });
}
