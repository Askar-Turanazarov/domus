// 2K photo textures (variant to Vercel Blob, see handoff): the 1K sets are in the repository (public/textures/sets),
// the 2K maps of the same sets are in a public Supabase Storage bucket `textures` (2k/<id>/<map>.jpg, uploaded by
// `npm run textures:2k`). The pages load them from our own origin /textures/2k/… (CSP img-src 'self'): on Vercel a
// rewrite in vercel.json (edge proxy, no function: a 2K normal map can be over the 4.5 MB function answer limit),
// locally the route below. No T_SUPABASE_URL (or SUPABASE_URL) → 2K is off and the pages keep 1K (kill switch).
import fs from 'node:fs/promises';
import path from 'node:path';

const LIBRARY = path.join(import.meta.dirname, '..', 'public', 'textures', 'library.json');
export const BUCKET = 'textures';
const TIMEOUT = 15 * 1000;

// The Vercel integration was connected with the prefix T_ (T_SUPABASE_URL …); the plain names work too.
export const supabaseUrl = (env = process.env) => String(env.T_SUPABASE_URL || env.SUPABASE_URL || '').replace(/\/+$/, '') || null;
export const supabaseKey = (env = process.env) => env.T_SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY || null;
export const publicMapUrl = (base, id, map) => `${base}/storage/v1/object/public/${BUCKET}/2k/${id}/${map}.jpg`;

let library = null;
const MAPS = ['color', 'normal', 'roughness', 'opacity'];
export async function mapsOfSet(id) {
  library ??= JSON.parse(await fs.readFile(LIBRARY, 'utf8'));
  const e = library.find(x => x.id === id);
  if (!e) return null;
  return Array.isArray(e.maps) ? e.maps.filter(k => MAPS.includes(k)) : ['color', 'normal', 'roughness'];
}

export function mountTextureHD(app, { env = process.env, fetchImpl = fetch } = {}) {
  // Whether the 3D may ask for 2K: the CDN keeps the answer 5 minutes, so the kill switch acts within minutes.
  app.get('/api/textures/hd', (req, res) => {
    res.set('Cache-Control', 'public, max-age=60, s-maxage=300').json({ on: !!supabaseUrl(env) });
  });

  app.get('/textures/2k/:id/:file', async (req, res) => {
    const base = supabaseUrl(env);
    const m = /^(\w+)\.jpg$/.exec(req.params.file);
    const id = String(req.params.id);
    const maps = /^\w+$/.test(id) ? await mapsOfSet(id) : null;
    if (!base || !m || !maps?.includes(m[1])) return res.set('Cache-Control', 'public, s-maxage=300').status(404).end();
    try {
      const r = await fetchImpl(publicMapUrl(base, id, m[1]), { signal: AbortSignal.timeout(TIMEOUT) });
      if (!r.ok) return res.set('Cache-Control', 'public, s-maxage=300').status(404).end();
      res.set('Cache-Control', 'public, max-age=604800, s-maxage=31536000, immutable').type('jpg').send(Buffer.from(await r.arrayBuffer()));
    } catch {
      res.status(504).end();
    }
  });
}
