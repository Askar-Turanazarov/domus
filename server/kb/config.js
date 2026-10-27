// The knowledge base's numbers (09 §5.3). KB_MIN_SCORE is calibrated by `npm run eval:kb` (19 §4).
export const KB_MIN_SCORE = 0.60;           // the best cosine at or above which there is an answer
export const KB_SOFT_GAP = 0.08;             // up to this far below the score it still answers when 2+ significant words match (0.52 for 0.60)
export const KB_TOP = 4;                    // chunks given to the consultant
export const KB_LIST = 8;                   // candidates of each of the two searches
export const KB_RRF_K = 60;
export const KB_CACHE = 200;                // questions whose vectors an instance remembers
export const KB_QUERY_MAX = 500;
export const EMBED_TAG = 'gemini-embedding-001@768';

// The score is a setting of the environment while calibrating: KB_MIN_SCORE=0.55 npm run eval:kb
export function minScore(env = process.env) {
  const v = Number(env.KB_MIN_SCORE);
  return Number.isFinite(v) && v > 0 && v < 1 ? v : KB_MIN_SCORE;
}
