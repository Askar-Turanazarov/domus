// The core's «now» (01 §12, P5): system time in production; tests move it by hand. Every deadline is counted from
// now() and SQL gets it as a parameter — never Date.now() or SQL now() in the core. Demo time travel does not touch it.
let fixed = null;

export const now = () => (fixed === null ? new Date() : new Date(fixed));

const UNIT = { s: 1e3, m: 60e3, h: 3600e3, d: 864e5 };
// '15m', '72h', '2d', '30s' or milliseconds
export const toMs = d => {
  if (typeof d === 'number') return d;
  const m = /^(-?\d+(?:\.\d+)?)([smhd])$/.exec(String(d).trim());
  if (!m) throw new Error(`bad duration: ${d}`);
  return Number(m[1]) * UNIT[m[2]];
};

// Tests only: fakeClock.set('2026-10-28T10:00:00+05:00'), fakeClock.advance('15m'), fakeClock.reset().
export const fakeClock = {
  set(t) {
    const ms = new Date(t).getTime();
    if (Number.isNaN(ms)) throw new Error(`bad time: ${t}`);
    fixed = ms;
    return now();
  },
  advance(d) { if (fixed === null) fixed = Date.now(); fixed += toMs(d); return now(); },
  reset() { fixed = null; }
};
