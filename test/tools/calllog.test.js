// The call log: every tool call and every refused request, without names, phones or the token.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeArgs, logEvent } from '../../server/tools/journal.js';
import { TOKEN, list, start } from './helpers.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-log-'));
const s = await start({ bookings: path.join(dir, 'booking.json') });
after(() => s.server.close());
const free = list.find(a => a.status === 'free');
const day = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);

test('each of the four tools leaves one line: tool, ok, ms, args, msg', async () => {
  await s.call('search_apartments', { rooms: 2, maxPrice: 900_000_000 });
  await s.call('get_apartment', { no: 9999 });
  await s.call('calc_mortgage', { loan: 80_000_000, years: 10, rate: 24 });
  await s.call('book_viewing', { name: 'Азиз', phone: '+998 90 555 12 34', datetime: `${day}T15:00`, no: free.no });
  const log = s.log();
  assert.deepEqual(log.map(e => [e.type, e.tool, e.ok]), [
    ['call', 'search_apartments', true], ['call', 'get_apartment', false], ['call', 'calc_mortgage', true], ['call', 'book_viewing', true]]);
  for (const e of log) {
    assert.ok(Number.isInteger(e.ms) && e.ms >= 0);
    assert.ok(!Number.isNaN(Date.parse(e.at)));
  }
  assert.deepEqual(log[0].args, { rooms: 2, maxPrice: 900_000_000 });
  assert.match(log[0].msg, /^Найдено: \d+$/);
  assert.match(log[1].msg, /№9999 не найдена/);
  assert.match(log[2].msg, /^Платёж 1\s763\s848 сум в месяц, переплата 131\s661\s730 сум$/);
  assert.deepEqual(log[3].args, { no: free.no, datetime: `${day}T15:00` });
  assert.equal(log[3].msg, `Записано на показ: квартира №${free.no}, ${day} 15:00`);
  // the same line in all three languages; msg is the Russian one
  for (const e of log) assert.deepEqual(Object.keys(e.msgs), ['ru', 'uz', 'en']), assert.equal(e.msgs.ru, e.msg);
  assert.equal(log[0].msgs.en.startsWith('Found: '), true);
  assert.match(log[1].msgs.uz, /^№9999 kvartira topilmadi/);
  assert.match(log[2].msgs.en, /^Monthly payment 1\s763\s848 sum, overpayment 131\s661\s730 sum$/);
  assert.equal(log[3].msgs.uz, `Ko‘rishga yozildi: №${free.no} kvartira, ${day} 15:00`);
});

test('the log never holds the name, the phone or the token', () => {
  const text = fs.readFileSync(s.files.calls, 'utf8');
  for (const secret of ['Азиз', '555 12 34', '+998', TOKEN]) assert.ok(!text.includes(secret), secret);
});

test('a refused request (no token / wrong token) is logged as denied, with no details', async () => {
  const before = s.log().length;
  await s.rpc('tools/list', {}, '');
  await s.rpc('tools/call', { name: 'search_apartments', arguments: {} }, 'wrong'.padEnd(40, 'z'));
  const added = s.log().slice(before);
  assert.deepEqual(added.map(e => [e.type, e.reason]), [['denied', 'no_token'], ['denied', 'bad_token']]);
  assert.ok(!fs.readFileSync(s.files.calls, 'utf8').includes('wrong'));
});

test('an unwritable log does not break the tools', async () => {
  const broken = await start({ calls: '/nonexistent/dir/mcp-calls.jsonl' });
  const r = await broken.call('search_apartments', { rooms: 2 });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /^Найдено/);
  broken.server.close();
});

test('safeArgs keeps everything but the booking\'s name and phone; parallel writes stay whole lines', async () => {
  assert.deepEqual(safeArgs('calc_mortgage', { no: 1, rate: 22 }), { no: 1, rate: 22 });
  assert.deepEqual(safeArgs('book_viewing', { name: 'A', phone: 'P', no: 1, datetime: 'D' }), { no: 1, datetime: 'D' });
  const file = path.join(dir, 'parallel.jsonl');
  await Promise.all(Array.from({ length: 50 }, (_, i) => logEvent(file, { type: 'call', tool: 't', i })));
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 50);
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
  const before = s.log().length;
  await s.call('book_viewing', { name: 'Азиз', phone: '+998 90 555 12 34', datetime: `${day}T17:00`, apartment: 28 });
  await s.call('no_such_tool', { client_phone: '+998 90 555 12 34' });
  // the line lands a moment after the answer: wait for it, then sort by time like the log page does
  for (let i = 0; i < 50 && s.log().length < before + 2; i++) await new Promise(ok => setTimeout(ok, 20));
  const added = s.log().slice(before).sort((x, y) => x.at.localeCompare(y.at));
  assert.deepEqual(added.map(e => [e.tool, e.ok, e.args.fields]), [
    ['book_viewing', false, ['name', 'phone', 'datetime', 'apartment']], ['no_such_tool', false, ['client_phone']]]);
  assert.match(added[0].msg, /Неверные параметры/);
  assert.equal(added[0].msgs.en, 'Invalid parameters: the call was refused before the tool');
  const text = fs.readFileSync(s.files.calls, 'utf8');
  for (const secret of ['Азиз', '555 12 34']) assert.ok(!text.includes(secret), secret);
});
