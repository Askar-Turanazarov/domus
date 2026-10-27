// The statuses from the base (computed from bookings and sales, D-15) win over apartments.json in every tool, as on the showcase.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FILES, applyStatuses } from '../../server/tools/index.js';
import { list, start } from './helpers.js';

const free = list.find(a => a.status === 'free');
const sold = list.find(a => a.status === 'sold');
const other = list.find(a => a.no !== free.no && a.no !== sold.no);
const own = { [free.building]: { [free.no]: 'sold', [sold.no]: 'free' } };
const s = await start({ statuses: async () => own });
after(() => s.close());
const day = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
const req = no => ({ name: 'Askar', phone: '+998 90 123 45 67', datetime: `${day}T15:00`, no });

test('applyStatuses: the manager wins, unknown values and other buildings are ignored, the list is not changed', () => {
  const out = applyStatuses(list, { 'other-house': { [free.no]: 'booked' }, [free.building]: { ...own[free.building], [other.no]: 'junk' } });
  assert.equal(out.find(a => a.no === free.no).status, 'sold');
  assert.equal(out.find(a => a.no === sold.no).status, 'free');
  assert.equal(out.find(a => a.no === other.no).status, other.status);
  assert.equal(free.status, 'free');
  assert.deepEqual(applyStatuses(list, {}), list);
});

test('get_apartment and search_apartments show the manager status', async () => {
  assert.equal((await s.call('get_apartment', { no: free.no })).structuredContent.status, 'sold');
  const found = (await s.call('search_apartments', { limit: 100 })).structuredContent.apartments.map(a => a.no);
  assert.ok(!found.includes(free.no));
  assert.ok(found.includes(sold.no));
});

test('book_viewing: sold by the manager is refused, released by the manager is booked', async () => {
  const r = await s.call('book_viewing', req(free.no));
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /продана/);
  const ok = await s.call('book_viewing', req(sold.no));
  assert.equal(ok.isError, undefined, ok.content?.[0]?.text);
});

test('the base: a sale or an active booking shows at once, an expired booking no longer holds the apartment', async () => {
  const s2 = await start();
  try {
    const status = async () => (await s2.call('get_apartment', { no: free.no })).structuredContent.status;
    assert.equal(await status(), 'free');
    const c = await s2.db.one("INSERT INTO clients (first_channel, created_at, updated_at) VALUES ('web', now(), now()) RETURNING id");
    const add = (st, ms) => s2.db.query(`INSERT INTO bookings (apartment_no, client_id, status, channel, created_by, expires_at, held_at,
      booked_at, deposit_amount, price_at_booking, updated_at) VALUES ($1, $2, $3, 'web', '{}', $4, now(), now(), 1, 1, now())`,
      [free.no, c.id, st, new Date(Date.now() + ms)]);
    await add('booked', -1000);
    assert.equal(await status(), 'free');
    await s2.db.query("UPDATE bookings SET status = 'expired' WHERE apartment_no = $1", [free.no]);
    await add('held', 15 * 60e3);
    assert.equal(await status(), 'booked');
    await s2.db.query('UPDATE apartments SET sold_at = now() WHERE no = $1', [free.no]);
    assert.equal(await status(), 'sold');
  } finally { await s2.close(); }
});

test('storage down: a plain error, the server keeps answering, apartments.json untouched', async () => {
  const before = fs.readFileSync(FILES.apartments, 'utf8');
  const s3 = await start({ statuses: async () => { throw new Error('db down'); } });
  try {
    const r = await s3.call('get_apartment', { no: free.no });
    assert.equal(r.isError, true);
    assert.doesNotMatch(r.content[0].text, /db down|[\/]/);
    assert.equal((await s3.call('calc_mortgage', { loan: 1000000, years: 1, rate: 0 })).isError, undefined);
  } finally { await s3.close(); }
  assert.equal(fs.readFileSync(FILES.apartments, 'utf8'), before);
});
