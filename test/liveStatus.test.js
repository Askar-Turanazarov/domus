// D2-14 (11 §3.2, §15): the showcase recolours only the apartments whose status changed, polls only while the page is
// visible, and a second visitor sees a hold made by the first one.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { diff, recolorCells, staleMinutes, createLiveStatus, POLL_MS } from '../public/js/liveStatus.js';
import { fakeClock } from '../server/core/clock.js';
import { createTestDb, resetDb } from './support/db.js';
import { startApi } from './support/api.js';

const facade = () => parseHTML(`<div id="f">
  <span class="bld-cell st-free" data-apt="41" title="№41 · Студия · 30 м² · Свободна"></span>
  <span class="bld-cell st-free" data-apt="42" title="№42 · Студия · 30 м² · Свободна"></span>
  <span class="bld-cell st-sold" data-apt="43" title="№43 · 2-комнатная · 60 м² · Продана"></span></div>`).document;

test('diff(): only what differs, in apartment order', () => {
  assert.deepEqual(diff({ 41: 'free', 42: 'free' }, { 42: 'held', 41: 'free', 43: 'sold' }), [[42, 'held'], [43, 'sold']]);
  assert.deepEqual(diff({ 41: 'free' }, { 41: 'free' }), []);
  assert.deepEqual(diff(null, { 41: 'free' }), [[41, 'free']]);
});

test('recolorCells(): the changed cell gets the new class and title, the others are not touched', () => {
  const doc = facade();
  const [a, b, c] = ['41', '42', '43'].map(n => doc.querySelector(`[data-apt="${n}"]`));
  const before = [b, c].map(x => x.outerHTML);
  const text = { held: 'Идёт оформление', free: 'Свободна' };
  // 41 changes, 42 is "changed" to what it already is, 43 is not in the list
  const touched = recolorCells(doc, [[41, 'held'], [42, 'free']], s => text[s]);
  assert.equal(touched, 1);
  assert.equal(a.className, 'bld-cell st-held');
  assert.equal(a.title, '№41 · Студия · 30 м² · Идёт оформление');
  assert.deepEqual([b, c].map(x => x.outerHTML), before);
  assert.equal(recolorCells(doc, [[99, 'held']], s => s), 0, 'an apartment that is not on the page is ignored');
});

test('staleMinutes(): nothing while fresh, minutes once two polls were missed', () => {
  assert.equal(staleMinutes(0, 15_000), null);
  assert.equal(staleMinutes(0, 2 * POLL_MS), null);
  assert.equal(staleMinutes(0, 2 * POLL_MS + 1), 1);
  assert.equal(staleMinutes(0, 5 * 60_000), 5);
});

// A page we can hide and a clock we can move; timers run when the test says so.
function rig(answers) {
  const listeners = {};
  const doc = { hidden: false, addEventListener: (n, f) => { listeners[n] = f; }, removeEventListener: n => { delete listeners[n]; } };
  const timers = new Map();
  let id = 0, ms = 0, calls = 0;
  const env = {
    doc, now: () => ms,
    fetch: async () => { const a = answers[Math.min(calls++, answers.length - 1)]; if (a === 'fail') throw new Error('offline'); return { ok: true, json: async () => a }; },
    setTimeout: (f, d) => { timers.set(++id, { f, at: ms + d }); return id; },
    clearTimeout: i => timers.delete(i)
  };
  return {
    env, doc, timers, get calls() { return calls; },
    hide() { doc.hidden = true; listeners.visibilitychange(); },
    show() { doc.hidden = false; listeners.visibilitychange(); },
    async tick(d = POLL_MS) { ms += d; for (const [i, t] of [...timers]) if (t.at <= ms) { timers.delete(i); await t.f(); } },
    settle: () => new Promise(r => setImmediate(r))
  };
}

test('createLiveStatus: the first answer at once, then every 10 s; only changes are reported', async () => {
  const r = rig([{ statuses: { 41: 'free', 42: 'free' }, at: 'x' }, { statuses: { 41: 'free', 42: 'free' } },
    { statuses: { 41: 'held', 42: 'free' }, mine: { 41: { link: '/b/1-a', expiresAt: 'z' } } }]);
  const seen = [];
  const live = createLiveStatus({ onUpdate: u => seen.push(u), env: r.env });
  live.start();
  await r.settle();
  assert.equal(r.calls, 1);
  assert.equal(seen[0].changes.length, 2, 'the first answer: everything is new');
  await r.tick(); await r.settle();
  assert.equal(seen[1].changes.length, 0);
  await r.tick(); await r.settle();
  assert.deepEqual(seen[2].changes, [[41, 'held']]);
  assert.deepEqual(seen[2].mine, { 41: { link: '/b/1-a', expiresAt: 'z' } });
  live.stop();
});

test('createLiveStatus: a hidden page does not ask; coming back asks at once', async () => {
  const r = rig([{ statuses: { 41: 'free' } }]);
  const live = createLiveStatus({ onUpdate: () => {}, env: r.env });
  live.start();
  await r.settle();
  r.hide();
  assert.equal(r.timers.size, 0, 'no timer while hidden');
  await r.tick(60_000);
  assert.equal(r.calls, 1);
  r.show(); await r.settle();
  assert.equal(r.calls, 2, 'visible again: an answer at once');
  assert.equal(r.timers.size, 1, 'and the poll goes on');
  live.stop();
});

test('createLiveStatus: no answer → the old data stays and the page says how old it is', async () => {
  const r = rig([{ statuses: { 41: 'free' } }, 'fail', 'fail', 'fail', { statuses: { 41: 'held' } }]);
  const stale = [], updates = [];
  const live = createLiveStatus({ onUpdate: u => updates.push(u), onStale: m => stale.push(m), env: r.env });
  live.start();
  await r.settle();
  await r.tick(); await r.settle();      // 10 s without an answer: still fresh
  assert.deepEqual(stale, []);
  await r.tick(); await r.settle();      // 20 s
  await r.tick(60_000); await r.settle(); // 80 s: ~1 min
  assert.deepEqual(stale, [1]);
  assert.equal(updates.length, 1, 'a failed poll changes nothing on the page');
  await r.tick(); await r.settle();
  assert.deepEqual(stale, [1, null], 'an answer again: the note goes');
  assert.deepEqual(updates[1].changes, [[41, 'held']]);
  live.stop();
});

// ---- a second visitor: the hold of the first one is on the showcase of the second one ----
let db, api;
before(async () => { db = await createTestDb(); api = await startApi(db); });
after(async () => { api.close(); await db.close(); });
beforeEach(async () => { await resetDb(db); fakeClock.set('2026-10-28T10:00:00+05:00'); });
afterEach(() => fakeClock.reset());

test('a second tab sees the hold; the holder gets a link to the booking, the stranger does not', async () => {
  const viewer = cookie => {
    const seen = [];
    const live = createLiveStatus({ onUpdate: u => seen.push(u), env: { doc: { hidden: false, addEventListener() {}, removeEventListener() {} },
      fetch: url => fetch(api.base + url, { headers: cookie ? { cookie } : {} }) } });
    return { live, seen };
  };
  const other = viewer(), first = viewer();
  await other.live.refresh();
  assert.equal(other.seen.at(-1).statuses[41], 'free');

  const h = await api.call('POST', '/api/bookings/hold', { apartmentNo: 41, name: 'Аня', phone: '+998 90 123 45 67', consent: { version: '2026-10-27', privacy: true } });
  assert.equal(h.status, 201, h.text);
  first.cookie = h.headers.get('set-cookie').split(';')[0];
  const mineView = viewer(first.cookie);

  await other.live.refresh();
  assert.deepEqual(other.seen.at(-1).changes, [[41, 'held']], 'the other tab recolours exactly this apartment');
  assert.deepEqual(other.seen.at(-1).mine, {});
  await mineView.live.refresh();
  assert.equal(mineView.seen.at(-1).mine[41].link, h.body.link);

  fakeClock.set('2026-10-28T10:16:00+05:00');   // the hold ran out
  await other.live.refresh();
  assert.deepEqual(other.seen.at(-1).changes, [[41, 'free']], 'and gives it back');
});
