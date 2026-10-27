// The call log (tool_calls): every tool call and every refused request, without names, phones or the token.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { safeArgs } from '../../server/tools/journal.js';
import { legacyStore } from '../../server/db/legacy.js';
import { TOKEN, list, start } from './helpers.js';

const s = await start();
after(() => s.close());
const logText = async () => JSON.stringify(await s.db.query('SELECT * FROM tool_calls'));
const free = list.find(a => a.status === 'free');
const day = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);

test('each of the four tools leaves one line: tool, ok, error code, ms, args', async () => {
  await s.call('search_apartments', { rooms: 2, maxPrice: 900_000_000 });
  await s.call('get_apartment', { no: 9999 });
  await s.call('calc_mortgage', { loan: 80_000_000, years: 10, rate: 24 });
  await s.call('book_viewing', { name: 'Азиз', phone: '+998 90 555 12 34', datetime: `${day}T15:00`, no: free.no });
  const log = await s.log();
  assert.deepEqual(log.map(e => [e.type, e.tool, e.ok, e.error]), [
    ['call', 'search_apartments', true, undefined], ['call', 'get_apartment', false, 'notFound'],
    ['call', 'calc_mortgage', true, undefined], ['call', 'book_viewing', true, undefined]]);
  for (const e of log) {
    assert.ok(Number.isInteger(e.ms) && e.ms >= 0);
    assert.ok(!Number.isNaN(Date.parse(e.at)));
  }
  assert.deepEqual(log[0].args, { rooms: 2, maxPrice: 900_000_000 });
  assert.deepEqual(log[3].args, { no: free.no, datetime: `${day}T15:00` });
});

test('the log never holds the name, the phone or the token', async () => {
  const text = await logText();
  for (const secret of ['Азиз', '555 12 34', '+998', TOKEN]) assert.ok(!text.includes(secret), secret);
});

test('a refused request (no token / wrong token) is logged as denied, with no details', async () => {
  const before = (await s.log()).length;
  await s.rpc('tools/list', {}, '');
  await s.rpc('tools/call', { name: 'search_apartments', arguments: {} }, 'wrong'.padEnd(40, 'z'));
  const added = (await s.log()).slice(before);
  assert.deepEqual(added.map(e => [e.type, e.reason]), [['denied', 'no_token'], ['denied', 'bad_token']]);
  assert.ok(!(await logText()).includes('wrong'));
});

test('an unwritable log does not break the tools', async () => {
  const down = legacyStore({ query: async () => { throw new Error('db down'); } });
  const broken = await start({ logCall: e => down.logCall(e) });
  const r = await broken.call('search_apartments', { rooms: 2 });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /^Найдено/);
  await broken.close();
});

test('safeArgs keeps everything but the name and phone of a booking', () => {
  assert.deepEqual(safeArgs('calc_mortgage', { no: 1, rate: 22 }), { no: 1, rate: 22 });
  assert.deepEqual(safeArgs('book_viewing', { name: 'A', phone: 'P', no: 1, datetime: 'D' }), { no: 1, datetime: 'D' });
});

// Found in the live run with the subagents: max_price instead of maxPrice was dropped silently,
// and a call refused by the input check (apartment instead of no) never reached the log.
test('unknown argument names are an error, not silently dropped', async () => {
  const r = await s.call('search_apartments', { rooms: 2, max_price: 900_000_000 });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /max_price/);
  for (const [tool, args] of [['get_apartment', { no: 1, extra: 1 }], ['calc_mortgage', { loan: 8e7, years: 10, rate: 24, term: 10 }],
    ['book_viewing', { name: 'Азиз', phone: '+998 90 555 12 34', datetime: `${day}T16:00`, apartment: 28 }]]) {
    assert.equal((await s.call(tool, args)).isError, true, tool);
  }
});

test('a call refused before the tool is logged with field names only, no values', async () => {
  await new Promise(ok => setTimeout(ok, 100));   // the previous test's refused calls finish writing
  const before = (await s.log()).length;
  await s.call('book_viewing', { name: 'Азиз', phone: '+998 90 555 12 34', datetime: `${day}T17:00`, apartment: 28 });
  await s.call('no_such_tool', { client_phone: '+998 90 555 12 34' });
  // the line lands a moment after the answer: wait for it, then sort by time like the log page does
  for (let i = 0; i < 50 && (await s.log()).length < before + 2; i++) await new Promise(ok => setTimeout(ok, 20));
  const added = (await s.log()).slice(before).sort((x, y) => x.at.localeCompare(y.at));
  assert.deepEqual(added.map(e => [e.tool, e.ok, e.error, e.args.fields]), [
    ['book_viewing', false, 'invalid_input', ['name', 'phone', 'datetime', 'apartment']], ['no_such_tool', false, 'invalid_input', ['client_phone']]]);
  const text = await logText();
  for (const secret of ['Азиз', '555 12 34']) assert.ok(!text.includes(secret), secret);
});
