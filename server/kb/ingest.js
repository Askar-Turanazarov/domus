// Indexing of the knowledge base (09 §4): kb/**/*.md → kb_documents + kb_chunks with vectors. A file that did not change
// costs nothing; a chunk whose text did not change keeps its vector. Without Gemini the chunks are saved without vectors
// and the next run with a key fills only the empty ones.
import fs from 'node:fs';
import path from 'node:path';
import { chunkDocument, sha256 } from './chunker.js';
import { EMBED_TAG } from './config.js';

const LANGS = ['ru', 'uz', 'en'];
const BATCH = 100;

const vec = v => `[${v.join(',')}]`;
const pause = ms => new Promise(r => setTimeout(r, ms));

export function readKbFiles(root) {
  const out = [];
  for (const lang of LANGS) {
    const dir = path.join(root, lang);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.md')).sort()) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      out.push({ slug: f.replace(/\.md$/, ''), lang, path: `kb/${lang}/${f}`, src, hash: sha256(src) });
    }
  }
  return out;
}

// Vectors for texts in batches; a refusal of the provider stops the embedding of this run (the rest stays empty).
async function embedAll(ai, texts, { sleep, stats, log }) {
  const vectors = new Array(texts.length).fill(null);
  if (!ai) { log.warn?.('kb:index — no Gemini key: the chunks are saved without vectors (search by words only)'); return vectors; }
  for (let i = 0; i < texts.length; i += BATCH) {
    if (i > 0) await sleep(stats.pauseMs);
    try {
      const r = await ai.embed({ texts: texts.slice(i, i + BATCH), taskType: 'RETRIEVAL_DOCUMENT' });
      r.vectors.forEach((v, j) => { vectors[i + j] = v; });
      stats.embedded += r.vectors.length;
    } catch (e) {
      log.warn?.(`kb:index — embeddings failed (${e?.cls ?? e?.message ?? 'error'}): the rest is saved without vectors`);
      stats.failed = true;
      break;
    }
  }
  return vectors;
}

// → { documents, chunks, embedded, skipped, removed, ms }
export async function ingest({ db, ai = null, root, log = console, sleep = pause, pauseMs = 1500 }) {
  const t0 = performance.now();
  const stats = { documents: 0, chunks: 0, embedded: 0, skipped: 0, removed: 0, failed: false, pauseMs };
  const files = readKbFiles(root);
  const known = new Map((await db.query('SELECT id, slug, lang, content_hash, path FROM kb_documents')).map(d => [`${d.lang}/${d.slug}`, d]));

  for (const f of files) {
    const key = `${f.lang}/${f.slug}`;
    const doc = known.get(key);
    known.delete(key);
    const { meta, chunks } = chunkDocument(f.src, f.slug);
    stats.documents++;
    stats.chunks += chunks.length;

    if (doc && doc.content_hash === f.hash) {                              // the file is the same: only the empty vectors are filled
      stats.skipped++;
      const empty = await db.query('SELECT id, heading, text FROM kb_chunks WHERE document_id = $1 AND embedding IS NULL ORDER BY ord', [doc.id]);
      if (!empty.length || !ai || stats.failed) continue;
      const vs = await embedAll(ai, empty.map(c => `${c.heading}\n\n${c.text}`), { sleep, stats, log });
      for (let i = 0; i < empty.length; i++) {
        if (vs[i]) await db.query('UPDATE kb_chunks SET embedding = $2::vector, embed_model = $3 WHERE id = $1', [empty[i].id, vec(vs[i]), EMBED_TAG]);
      }
      continue;
    }

    const old = doc ? await db.query('SELECT content_hash, embedding::text AS v FROM kb_chunks WHERE document_id = $1 AND embedding IS NOT NULL AND embed_model = $2', [doc.id, EMBED_TAG]) : [];
    const reuse = new Map(old.map(c => [c.content_hash, c.v]));
    const todo = chunks.filter(c => !reuse.has(c.hash));
    const vs = stats.failed ? todo.map(() => null) : await embedAll(ai, todo.map(c => c.embedText), { sleep, stats, log });
    const fresh = new Map(todo.map((c, i) => [c.hash, vs[i]]));

    await db.tx(async q => {
      const row = await q.one(
        `INSERT INTO kb_documents (slug, lang, title, topic, path, content_hash, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (slug, lang) DO UPDATE SET title = $3, topic = $4, path = $5, content_hash = $6, updated_at = $7 RETURNING id`,
        [f.slug, f.lang, meta.title, meta.topic ?? '', f.path, f.hash, `${meta.updated || '1970-01-01'}T00:00:00+05:00`]);
      await q.query('DELETE FROM kb_chunks WHERE document_id = $1', [row.id]);
      for (const c of chunks) {
        const v = reuse.get(c.hash) ?? (fresh.get(c.hash) ? vec(fresh.get(c.hash)) : null);
        await q.query(
          `INSERT INTO kb_chunks (document_id, ord, lang, heading, text, content_hash, embedding, embed_model)
           VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8)`,
          [row.id, c.ord, f.lang, c.heading, c.text, c.hash, v, v ? EMBED_TAG : null]);
      }
    });
  }

  for (const gone of known.values()) {                                      // files removed from kb/: the document and its chunks go
    await db.query('DELETE FROM kb_documents WHERE id = $1', [gone.id]);
    stats.removed++;
  }
  return { documents: stats.documents, chunks: stats.chunks, embedded: stats.embedded, skipped: stats.skipped,
    removed: stats.removed, partial: stats.failed || !ai, ms: Math.round(performance.now() - t0) };
}
