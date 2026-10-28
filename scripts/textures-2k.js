// npm run textures:2k [-- --force] [--only id,id]: the 2K maps of every library set into the Supabase bucket `textures`
// (2k/<id>/<map>.jpg, public read, cached a year). The ambientCG 2K-JPG zip of each set is downloaded and only its
// maps are kept, byte for byte (server/textureFetch.js mapsFromZip). Sets already in the bucket are skipped (--force
// uploads again). T_SUPABASE_URL and T_SUPABASE_SERVICE_ROLE_KEY from the environment (.env); the key is never printed.
import fs from 'node:fs/promises';
import { mapsFromZip } from '../server/textureFetch.js';
import { supabaseUrl, supabaseKey, publicMapUrl, mapsOfSet, BUCKET } from '../server/textureHD.js';

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const ONLY = (() => { const i = args.indexOf('--only'); return i >= 0 ? args[i + 1].split(',') : null; })();
const base = supabaseUrl(), key = supabaseKey();
if (!base || !key) {
  console.error('T_SUPABASE_URL and T_SUPABASE_SERVICE_ROLE_KEY are needed (in .env)');
  process.exit(1);
}
const auth = { Authorization: `Bearer ${key}`, apikey: key };
const mb = n => (n / 1048576).toFixed(1) + ' MB';

async function ensureBucket() {
  const r = await fetch(`${base}/storage/v1/bucket`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true, allowed_mime_types: ['image/jpeg'] }) });
  const body = await r.json().catch(() => ({}));
  if (r.ok) return console.log(`bucket ${BUCKET}: created (public)`);
  if (/exists|duplicate/i.test(JSON.stringify(body))) return console.log(`bucket ${BUCKET}: already there`);
  throw new Error(`bucket → ${r.status} ${body.message || body.error || ''}`);
}

async function uploaded(id, maps) {
  const heads = await Promise.all(maps.map(m => fetch(publicMapUrl(base, id, m), { method: 'HEAD' }).then(r => r.ok, () => false)));
  return heads.every(Boolean);
}

async function one(e) {
  const maps = await mapsOfSet(e.id);
  if (!FORCE && await uploaded(e.id, maps)) return { id: e.id, skipped: true };
  const zip = await fetch(`https://ambientcg.com/get?file=${e.source.ambientcg}_2K-JPG.zip`, { signal: AbortSignal.timeout(180e3) });
  if (!zip.ok) throw new Error(`ambientCG → ${zip.status}`);
  const files = mapsFromZip(Buffer.from(await zip.arrayBuffer()), maps);
  const sizes = {};
  for (const [map, buf] of Object.entries(files)) {
    const r = await fetch(`${base}/storage/v1/object/${BUCKET}/2k/${e.id}/${map}.jpg`, { method: 'POST',
      headers: { ...auth, 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=31536000', 'x-upsert': 'true' }, body: buf });
    if (!r.ok) throw new Error(`upload ${map} → ${r.status} ${(await r.text()).slice(0, 120)}`);
    sizes[map] = buf.length;
  }
  return { id: e.id, sizes };
}

const lib = JSON.parse(await fs.readFile(new URL('../public/textures/library.json', import.meta.url), 'utf8'))
  .filter(e => /^[A-Za-z0-9]+$/.test(e.source?.ambientcg || '') && (!ONLY || ONLY.includes(e.id)));
await ensureBucket();
let total = 0, biggest = 0, failed = 0;
const queue = [...lib];
await Promise.all([1, 2, 3].map(async () => {
  for (let e; (e = queue.shift());) {
    try {
      const r = await one(e);
      if (r.skipped) { console.log(`  ${e.id}: already there`); continue; }
      const sum = Object.values(r.sizes).reduce((a, b) => a + b, 0);
      total += sum;
      biggest = Math.max(biggest, ...Object.values(r.sizes));
      console.log(`  ${e.id}: ${Object.entries(r.sizes).map(([k, v]) => `${k} ${mb(v)}`).join(', ')}`);
    } catch (err) {
      failed++;
      console.error(`  ${e.id}: ${err.message}`);
    }
  }
}));
console.log(`${lib.length} sets, uploaded ${mb(total)}, biggest map ${mb(biggest)}, failed ${failed}`);
process.exit(failed ? 1 : 0);
