import { test } from 'node:test';
import assert from 'node:assert/strict';
import { styleOf, surfacesOf } from '../public/js/style.js';
import { listZip, readEntry, writeZip, crc32 } from '../server/zip.js';
import { mapsFromZip, downloadable } from '../server/textureFetch.js';

const files = [
  { name: 'a.txt', data: Buffer.from('hello hello hello hello') },
  { name: 'img_Color.jpg', data: Buffer.alloc(20000, 7) }
];

test('zip reader: stored and deflated entries round-trip', () => {
  for (const deflate of [false, true]) {
    const buf = writeZip(files, { deflate });
    const list = listZip(buf);
    assert.deepEqual(list.map(e => [e.name, e.method]), files.map(f => [f.name, deflate ? 8 : 0]));
    list.forEach((e, i) => assert.deepEqual(readEntry(buf, e), files[i].data));
  }
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('zip reader: broken archives and oversized entries are rejected', () => {
  assert.throws(() => listZip(Buffer.from('not a zip at all, definitely not')), /not a zip/);
  const buf = writeZip(files, { deflate: true });
  const big = listZip(buf)[1];
  assert.throws(() => readEntry(buf, big, 1000), /too large/);
  assert.throws(() => readEntry(buf.subarray(0, 100), big), /truncated|bad local header/);
});

test('texture maps: names with a path (traversal) are ignored', () => {
  const zip = (names) => writeZip(names.map(name => ({ name, data: Buffer.from(name) })));
  const ok = mapsFromZip(zip(['X_Color.jpg', 'X_NormalGL.jpg', 'X_Roughness.jpg', 'X_NormalDX.jpg']));
  assert.equal(ok.color.toString(), 'X_Color.jpg');
  assert.equal(ok.normal.toString(), 'X_NormalGL.jpg');
  assert.throws(() => mapsFromZip(zip(['../../evil_Color.jpg', 'X_NormalGL.jpg', 'X_Roughness.jpg'])), /missing color/);
  assert.throws(() => mapsFromZip(zip(['dir\\X_Color.jpg', 'X_NormalGL.jpg', 'X_Roughness.jpg'])), /missing color/);
});

test('texture maps: a set with its own list (leaves: colour and opacity)', () => {
  const zip = (names) => writeZip(names.map(name => ({ name, data: Buffer.from(name) })));
  const m = mapsFromZip(zip(['L_Color.jpg', 'L_Opacity.jpg']), ['color', 'opacity']);
  assert.deepEqual(Object.keys(m), ['color', 'opacity']);
  assert.equal(m.opacity.toString(), 'L_Opacity.jpg');
  assert.throws(() => mapsFromZip(zip(['L_Color.jpg'])), /missing normal/);
});

test('download whitelist: only on-demand sets of the library', async () => {
  // every set of the library is in the repo now (public/textures/sets): nothing is fetched on demand
  for (const id of ['blocksGrey', 'brick','../server', 'nope', '', 'constructor', '__proto__']) assert.equal(await downloadable(id), null, id);
});

test('library set overrides in the style', () => {
  const s = styleOf({ floor: 'marble', tex: { floor: 'marbleWhite', wall: '../x', roughWall: 'blocksGrey', bogus: 'a' } });
  assert.deepEqual(s.tex, { floor: 'marbleWhite', roughWall: 'blocksGrey' });
  assert.equal(surfacesOf(s).floorSet, 'marbleWhite');
  assert.equal(surfacesOf({ ...s, finish: 'rough' }).wallSet, 'blocksGrey');
  assert.equal(surfacesOf({ ...s, finish: 'prefinish' }).wallSet, 'putty');
  assert.equal('tex' in styleOf({}), false);
});
