// 2K maps from Supabase Storage (server/textureHD.js): the flag of the kill switch, the same-origin proxy with the
// library whitelist, the env names of the Vercel integration (prefix T_).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mountTextureHD, supabaseUrl, publicMapUrl } from '../server/textureHD.js';

async function serve(env, fetchImpl) {
  const app = express();
  mountTextureHD(app, { env, fetchImpl });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { get: p => fetch(base + p), close: () => server.close() };
}

test('env: T_SUPABASE_URL wins, plain SUPABASE_URL works, trailing slash dropped; none → off', () => {
  assert.equal(supabaseUrl({ T_SUPABASE_URL: 'https://a.supabase.co/', SUPABASE_URL: 'https://b.supabase.co' }), 'https://a.supabase.co');
  assert.equal(supabaseUrl({ SUPABASE_URL: 'https://b.supabase.co' }), 'https://b.supabase.co');
  assert.equal(supabaseUrl({}), null);
  assert.equal(publicMapUrl('https://a.supabase.co', 'oakPlanks', 'normal'), 'https://a.supabase.co/storage/v1/object/public/textures/2k/oakPlanks/normal.jpg');
});

test('kill switch: no Supabase URL → /api/textures/hd off and no 2K maps', async () => {
  let asked = 0;
  const s = await serve({}, async () => { asked++; return new Response('x'); });
  try {
    assert.deepEqual(await (await s.get('/api/textures/hd')).json(), { on: false });
    assert.equal((await s.get('/textures/2k/oakPlanks/color.jpg')).status, 404);
    assert.equal(asked, 0);
  } finally { s.close(); }
});

test('2K proxy: library sets and their maps only; bytes and a long cache; a missing or failing map → 404 / 504', async () => {
  const seen = [];
  const s = await serve({ T_SUPABASE_URL: 'https://x.supabase.co' }, async url => {
    seen.push(url);
    if (url.includes('/brass/')) throw new Error('down');
    return url.includes('/marbleWhite/') ? new Response('', { status: 400 }) : new Response(Buffer.from('JPEG'));
  });
  try {
    const hd = await s.get('/api/textures/hd');
    assert.deepEqual(await hd.json(), { on: true });
    assert.match(hd.headers.get('cache-control'), /s-maxage=300/);
    const ok = await s.get('/textures/2k/oakPlanks/normal.jpg');
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/jpeg');
    assert.match(ok.headers.get('cache-control'), /s-maxage=31536000/);
    assert.equal(await ok.text(), 'JPEG');
    assert.deepEqual(seen, ['https://x.supabase.co/storage/v1/object/public/textures/2k/oakPlanks/normal.jpg']);
    for (const p of ['/textures/2k/nope/color.jpg', '/textures/2k/oakPlanks/opacity.jpg', '/textures/2k/oakPlanks/color.png',
      '/textures/2k/..%2Fx/color.jpg', '/textures/2k/constructor/color.jpg']) {
      assert.equal((await s.get(p)).status, 404, p);
    }
    assert.equal(seen.length, 1, 'nothing outside the whitelist is asked for');
    assert.equal((await s.get('/textures/2k/marbleWhite/color.jpg')).status, 404);
    assert.equal((await s.get('/textures/2k/brass/color.jpg')).status, 504);
  } finally { s.close(); }
});
