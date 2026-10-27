// eval/reports/neon-concurrency-<date>.md (15 §4 step 8): per step — attempts, right outcomes, time; and the verdict.
const TITLE = {
  holds: '20 holds on one apartment (core, 20 connections)',
  'http-holds': '20 × POST /api/bookings/hold (HTTP)',
  payments: '10 payments of one booking reported paid at once',
  'stripe-duplicates': '10 deliveries of one Stripe event',
  'click-duplicates': '10 Click Complete with one click_trans_id',
  jobs: '50 due jobs, 5 callers of POST /api/jobs/run'
};

export function summarize(results) {
  const steps = [...new Set(results.map(r => r.step))];
  const rows = steps.map(step => {
    const rs = results.filter(r => r.step === step);
    return { step, rounds: rs.length, attempts: rs.reduce((n, r) => n + r.attempts, 0), ok: rs.reduce((n, r) => n + r.ok, 0),
      failed: rs.filter(r => r.failures.length).length, ms: Math.round(rs.reduce((n, r) => n + r.ms, 0) / rs.length) };
  });
  return { rows, pass: results.length > 0 && results.every(r => !r.failures.length) };
}

export function renderReport(results, { date, endpoint, rounds }) {
  const { rows, pass } = summarize(results);
  const lines = [`# Neon concurrency — ${date}`, '',
    `Base: \`${endpoint}\` (a throwaway branch, emptied before every round). Rounds: ${rounds}. Verdict: **${pass ? 'PASS' : 'FAIL'}** — ` +
    (pass ? '0 double bookings, 0 double payments, every job exactly once (DoD-3, DoD-4).' : 'see the failures below.'), '',
    '| Step | Rounds | Attempts | Right outcomes | Rounds with a failure | Mean time, ms |', '|---|---|---|---|---|---|',
    ...rows.map(r => `| ${TITLE[r.step] ?? r.step} | ${r.rounds} | ${r.attempts} | ${r.ok} | ${r.failed} | ${r.ms} |`)];
  const bad = results.filter(r => r.failures.length);
  if (bad.length) lines.push('', '## Failures', ...bad.map(r => `- round ${r.round}, ${r.step}: ${r.failures.join('; ')}`));
  return `${lines.join('\n')}\n`;
}
