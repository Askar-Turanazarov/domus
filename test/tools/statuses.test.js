// The manager's statuses (site storage, /admin.html) win over apartments.json in every tool, as on the showcase.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb } from '../../server/db.js';
import { FILES, applyStatuses } from '../../server/tools/index.js';
import { list, start } from './helpers.js';

const free = list.find(a => a.status === 'free');
const sold = list.find(a => a.status === 'sold');
const other = list.find(a => a.no !== free.no && a.no !== sold.no);
const own = { [free.building]: { [free.no]: 'sold', [sold.no]: 'free' } };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-status-'));
const s = await start({ bookings: path.join(dir, 'booking.json'), statuses: async () => own });
after(() => s.server.close());
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

test('the site file storage (data/building-status.json) is read as is', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-data-'));
  const db = createDb({ url: '', root: dataDir, dataDir });
  await db.setStatus(free.building, free.no, 'booked');
  const s2 = await start({ bookings: path.join(dir, 'b2.json'), statuses: () => db.statuses() });
  try { assert.equal((await s2.call('get_apartment', { no: free.no })).structuredContent.status, 'booked'); } finally { s2.server.close(); }
});

test('storage down: a plain error, the server keeps answering, apartments.json untouched', async () => {
  const before = fs.readFileSync(FILES.apartments, 'utf8');
  const s3 = await start({ statuses: async () => { throw new Error('db down'); } });
  try {
    const r = await s3.call('get_apartment', { no: free.no });
    assert.equal(r.isError, true);
    assert.doesNotMatch(r.content[0].text, /db down|[\/]/);
    assert.equal((await s3.call('calc_mortgage', { loan: 1000000, years: 1, rate: 0 })).isError, undefined);
  } finally { s3.server.close(); }
  assert.equal(fs.readFileSync(FILES.apartments, 'utf8'), before);
});
