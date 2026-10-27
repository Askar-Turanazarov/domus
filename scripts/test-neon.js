// npm run test:neon — the parallel test on a throwaway Neon branch (15 §4, DoD-3, DoD-4). Needs TEST_DATABASE_URL (the
// branch `test`, 16 §4); without it the test is skipped. It EMPTIES the base it runs on, so it refuses every base that
// is also named in DATABASE_URL anywhere (production, dev). Rounds: 5 (15 §4 step 7), ROUNDS=1 for a quick look.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { neonDb } from '../server/db/neon.js';
import { migrate } from '../server/db/migrate.js';
import { checkTestUrl } from './neon/guard.js';
import { runRound, STRIPE_ENV } from './neon/scenarios.js';
import { renderReport, summarize } from './neon/report.js';

const ROOT = path.join(import.meta.dirname, '..');
const PORT = Number(process.env.TEST_NEON_PORT) || 3790;
const ROUNDS = Number(process.env.ROUNDS) || 5;
const url = process.env.TEST_DATABASE_URL;

if (!url) {
  console.log('test:neon skipped: TEST_DATABASE_URL is not set (the Neon branch `test`, 16 §4; put its connection string into .env).');
  process.exit(0);
}
const guard = checkTestUrl(url);
if (!guard.ok) {
  console.error(`test:neon refused: ${guard.reason}${guard.endpoint ? ` (${guard.endpoint})` : ''}. It must be a separate Neon branch, never the base of DATABASE_URL.`);
  process.exit(2);
}

// The server of step 3 and 6: the real site on the test base, with nothing that could reach the outside world.
function serverEnv() {
  const blank = {};
  for (const file of ['.env.local', '.env']) {
    try { for (const line of readFileSync(path.join(ROOT, file), 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=/); if (m) blank[m[1]] = ''; } } catch { /* no file */ }
  }
  return { ...process.env, ...blank, PORT: String(PORT), DATABASE_URL: url, PUBLIC_URL: `http://127.0.0.1:${PORT}`, NODE_ENV: 'test',
    LINK_SECRET: 'neon-test-link', SESSION_SECRET: 'neon-test-session', LOG_SALT: 'neon-test-salt', CRON_SECRET: 'neon-test-cron',
    QSTASH_CURRENT_SIGNING_KEY: QSTASH.key, QSTASH_NEXT_SIGNING_KEY: 'neon-test-next', ...STRIPE_ENV };
}
const QSTASH = { key: 'neon-test-signing-key', url: `http://127.0.0.1:${PORT}/api/jobs/run` };

const db = neonDb(url, { max: 24 });
let child;
try {
  console.log(`test:neon on ${guard.endpoint}`);
  console.log('migrations applied now:', (await migrate(db)).join(', ') || 'none');
  child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: serverEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  for (let i = 0; ; i++) {
    if (i > 60) throw new Error(`the test server did not start:\n${log.slice(-800)}`);
    if (await fetch(`http://127.0.0.1:${PORT}/api/health`).then(r => r.ok, () => false)) break;
    await new Promise(r => setTimeout(r, 500));
  }

  const results = [];
  for (let round = 1; round <= ROUNDS; round++) {
    const out = await runRound(db, { round, baseUrl: `http://127.0.0.1:${PORT}`, qstash: QSTASH });
    results.push(...out);
    console.log(`round ${round}: ${out.map(r => `${r.step} ${r.ok}/${r.attempts}${r.failures.length ? ' FAIL' : ''}`).join(', ')}`);
    for (const r of out) for (const f of r.failures) console.log(`  ✖ ${r.step}: ${f}`);
  }
  const date = new Date().toISOString().slice(0, 10);
  const dir = path.join(ROOT, 'eval', 'reports');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `neon-concurrency-${date}.md`);
  writeFileSync(file, renderReport(results, { date, endpoint: guard.endpoint, rounds: ROUNDS }));
  console.log(`report: ${path.relative(ROOT, file)} — ${summarize(results).pass ? 'PASS' : 'FAIL'}`);
  process.exitCode = summarize(results).pass ? 0 : 1;
} finally {
  child?.kill();
  await db.close();
}
