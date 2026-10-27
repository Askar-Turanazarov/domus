// Gemini free-tier counters (06 §7) over ai_calls: per model, per minute and per Pacific day (the quota resets at
// midnight America/Los_Angeles — 13:00 Tashkent in November). Day borders without libraries, through Intl.
import { MODELS } from './models.js';

const PT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

// The Pacific wall clock of a moment → its offset from UTC in ms (negative: −7 h or −8 h).
function ptOffset(ms) {
  const p = Object.fromEntries(PT.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}

function ptDate(ms) {
  const p = Object.fromEntries(PT.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day };
}

// Midnight of a Pacific calendar day: the offset is taken at midnight itself (it differs from now's on a DST day).
function ptMidnight(y, m, d) {
  const wall = Date.UTC(y, m - 1, d);
  let t = wall - ptOffset(wall);
  t = wall - ptOffset(t);
  return new Date(t);
}

export function pacificDayStart(at) {
  const { y, m, d } = ptDate(at.getTime());
  return ptMidnight(y, m, d);
}

export function nextPacificMidnight(at) {
  const { y, m, d } = ptDate(at.getTime());
  return ptMidnight(y, m, d + 1);
}

// Tashkent has no DST: UTC+5.
const TASHKENT = 5 * 3600e3;
export const tashkentDayStart = at => new Date(Math.floor((at.getTime() + TASHKENT) / 864e5) * 864e5 - TASHKENT);
export const nextTashkentMidnight = at => new Date(tashkentDayStart(at).getTime() + 864e5);

// db — the base; now — the clock. Counts every request, failed ones too: Google counts them.
export function createQuota({ db, now }) {
  async function counts(model) {
    const at = now();
    const r = await db.one(`SELECT count(*) FILTER (WHERE at > $2)::int AS minute, count(*) FILTER (WHERE at >= $3)::int AS day,
        min(at) FILTER (WHERE at > $2) AS oldest
      FROM ai_calls WHERE provider = 'gemini' AND model = $1 AND at >= LEAST($2, $3)`,
    [model, new Date(at.getTime() - 60_000), pacificDayStart(at)]);
    return { minute: r?.minute || 0, day: r?.day || 0, oldest: r?.oldest ? new Date(r.oldest) : null };
  }

  // → null, or { until, reason: 'quota_guard' } when one request is left in this minute (skip it, §7),
  // or the day is used up.
  async function guard(model) {
    const cfg = MODELS[model];
    if (!db || cfg?.provider !== 'gemini' || !cfg.rpm) return null;
    try {
      const c = await counts(model);
      if (cfg.rpd && c.day >= cfg.rpd) return { until: nextPacificMidnight(now()), reason: 'rate_day' };
      if (c.minute >= cfg.rpm - 1) return { until: new Date((c.oldest || now()).getTime() + 60_000), reason: 'quota_guard' };
      return null;
    } catch { return null; }   // no counters → no guard; a real 429 still switches the model
  }

  return { counts, guard };
}
