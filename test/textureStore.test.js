// Downloaded library sets in Vercel Blob (server/textureFetch.js blobStore) — with a fake SDK, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blobStore, readLibMap } from '../server/textureFetch.js';

function fakeSdk() {
  const files = new Map(), calls = { list: 0 };
  return {
    files, calls,
    async list({ prefix, cursor }) {
      calls.list++;
      const all = [...files.keys()].filter(k => k.startsWith(prefix)).sort();
      const from = cursor ? Number(cursor) : 0, page = all.slice(from, from + 2);
      return { blobs: page.map(pathname => ({ pathname })), hasMore: from + 2 < all.length, cursor: String(from + 2) };
    },
    async put(key, buf, opts) {
      assert.equal(opts.addRandomSuffix, false);
      assert.equal(opts.allowOverwrite, true);
      files.set(key, buf);
    },
    async get(key) {
      return files.has(key) ? { statusCode: 200, stream: new Blob([files.get(key)]).stream() } : null;
    }
  };
}

test('blob store: write, list (all pages, cached), read', async () => {
  const sdk = fakeSdk();
  sdk.files.set('textures/lib/a/color.jpg', Buffer.from('x'));
  sdk.files.set('textures/lib/a/normal.jpg', Buffer.from('y'));
  const store = blobStore('t', sdk);
  assert.equal(await store.has('a', 'color'), true);
  assert.equal(await store.has('b', 'color'), false);
  await store.write('b', 'color', Buffer.from('jpeg'));
  assert.equal(await store.has('b', 'color'), true);       // known without listing again
  assert.ok(sdk.calls.list <= 2);
  assert.deepEqual(await store.read('b', 'color'), Buffer.from('jpeg'));
  assert.equal(await store.read('c', 'color'), null);
});

test('readLibMap: only library ids and their maps', async () => {
  for (const [id, map] of [['../server', 'color'], ['blocksGrey', 'opacity'], ['blocksGrey', '../x'], ['travertine', 'color']]) {
    assert.equal(await readLibMap(id, map), null, id + '/' + map);
  }
});
