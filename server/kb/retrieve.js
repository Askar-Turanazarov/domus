// Search in the knowledge base (09 §5): the vector part and the words part, merged by RRF; a threshold that turns
// «nothing close» into an honest refusal; words only when the embeddings are not available. Every search is a row of kb_queries.
import { now } from '../core/clock.js';
import { minScore, KB_SOFT_GAP, KB_TOP, KB_LIST, KB_RRF_K, KB_CACHE, KB_QUERY_MAX } from './config.js';
import { prepare, tsOr, matched } from './text.js';

const vec = v => `[${v.join(',')}]`;
const idArray = ids => `{${ids.join(',')}}`;

export function createKb({ db, ai = null, env = process.env, log = console } = {}) {
  const cache = new Map();                                                  // question + language → vector (an instance remembers 200)

  async function queryVector(text, lang) {
    const key = `${lang}:${text.toLowerCase()}`;
    if (cache.has(key)) { const v = cache.get(key); cache.delete(key); cache.set(key, v); return v; }
    if (!ai) return null;
    try {
      const r = await ai.embed({ texts: [text], taskType: 'RETRIEVAL_QUERY' });
      const v = r.vectors?.[0] ?? null;
      if (v) { cache.set(key, v); if (cache.size > KB_CACHE) cache.delete(cache.keys().next().value); }
      return v;
    } catch (e) {
      log.warn?.('kb: embeddings unavailable, search by words only:', e?.cls ?? e?.message);
      return null;
    }
  }

  // → { answered, mode, chunks?, reason?, topScore }
  async function retrieve({ query, lang = 'ru', conversationId = null, journal = true }) {
    const t0 = performance.now();
    const { text, stems } = prepare(query, lang, KB_QUERY_MAX);
    const min = minScore(env);
    const v = text ? await queryVector(text, lang) : null;
    const q = v ? vec(v) : null;

    const vector = q ? await db.query(
      `SELECT id, 1 - (embedding <=> $1::vector) AS score FROM kb_chunks WHERE lang = $2 AND embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector LIMIT ${KB_LIST}`, [q, lang]) : [];
    const words = stems.length ? await db.query(
      `SELECT id, ts_rank(tsv, query) AS rank FROM kb_chunks, to_tsquery('simple', $1) query
       WHERE lang = $2 AND tsv @@ query ORDER BY rank DESC, id LIMIT ${KB_LIST}`, [tsOr(stems), lang]) : [];

    const mode = vector.length ? 'hybrid' : 'keyword_only';
    const rrf = new Map();
    for (const list of mode === 'hybrid' ? [vector, words] : [words]) {
      list.forEach((r, i) => rrf.set(r.id, (rrf.get(r.id) ?? 0) + 1 / (KB_RRF_K + i + 1)));
    }
    const ids = [...rrf.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, KB_TOP).map(e => e[0]);

    const rows = ids.length ? await db.query(
      `SELECT c.id, c.heading, c.text, d.slug AS doc ${q ? ', CASE WHEN c.embedding IS NULL THEN NULL ELSE 1 - (c.embedding <=> $2::vector) END AS score' : ', NULL::float AS score'}
       FROM kb_chunks c JOIN kb_documents d ON d.id = c.document_id WHERE c.id = ANY($1::bigint[])`,
      q ? [idArray(ids), q] : [idArray(ids)]) : [];
    const byId = new Map(rows.map(r => [r.id, r]));
    const chunks = ids.map(id => byId.get(id)).filter(Boolean)
      .map((r, i) => ({ n: i + 1, id: r.id, heading: r.heading, text: r.text, doc: r.doc, score: r.score == null ? null : Number(r.score),
        hits: matched(stems, r.heading, r.text) }));

    let answered;
    let topScore = null;
    if (mode === 'hybrid') {
      topScore = vector[0] ? Number(vector[0].score) : null;
      answered = topScore >= min || (topScore >= min - KB_SOFT_GAP && chunks.some(c => c.hits >= 2));
    } else {
      topScore = words[0] ? Number(words[0].rank) : null;
      answered = chunks.length > 0 && topScore > 0 && chunks.some(c => c.hits >= 2);
    }

    const out = answered
      ? { answered: true, mode, topScore, chunks: chunks.map(({ hits, ...c }) => c) }
      : { answered: false, mode, topScore, reason: 'below_threshold' };
    if (journal) await db.query(
      `INSERT INTO kb_queries (at, conversation_id, lang, query, mode, top_score, chunk_ids, answered, ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7::bigint[], $8, $9)`,
      [now(), conversationId, lang, text, mode, topScore, idArray(ids), answered, Math.round(performance.now() - t0)]);
    return out;
  }

  return { retrieve };
}
