// A fake «embedding model» (no keys, no network): a normalised bag of word stems hashed into 768 slots, so texts that
// share words are close and unrelated texts are not — enough to test ranking, the threshold and the reuse of vectors.
import crypto from 'node:crypto';
import { words, stem } from '../../server/kb/text.js';

export const DIMS = 768;

export function embedText(text) {
  const v = new Array(DIMS).fill(0);
  for (const w of words(text)) {
    if (w.length < 3) continue;
    v[crypto.createHash('md5').update(stem(w)).digest().readUInt16BE(0) % DIMS] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
}

// ai.embed() of the real layer: { texts, taskType } → { vectors, usage }. `batches` keeps what was asked.
export function fakeEmbedAi({ fail = null } = {}) {
  const batches = [];
  return {
    batches,
    fail(v) { fail = v; },
    async embed({ texts, taskType }) {
      batches.push({ texts, taskType });
      if (fail) throw Object.assign(new Error('embed failed'), { cls: fail });
      return { vectors: texts.map(embedText), usage: { input: 0, output: 0, cached: 0 } };
    }
  };
}
