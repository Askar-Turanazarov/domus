// npm run eval:kb [-- --yes] — the golden set of 30 questions against the base (09 §8) → eval/reports/kb-<date>.md.
// Needs the base indexed with real vectors (npm run kb:index) and GEMINI_API_KEY; without the key it runs by words only.
import fs from 'node:fs';
import path from 'node:path';
import { openTarget } from './dbTarget.js';
import { migrate } from '../server/db/migrate.js';
import { createAi } from '../server/ai/index.js';
import { createKb } from '../server/kb/retrieve.js';
import { minScore } from '../server/kb/config.js';
import { runEval, renderReport } from '../server/kb/eval.js';
import { now } from '../server/core/clock.js';

const root = path.join(import.meta.dirname, '..');
const args = process.argv.slice(2);
const db = openTarget(args);
try {
  const ready = await db.ready();
  if (db.kind === 'pglite') await migrate(ready);
  const ai = process.env.GEMINI_API_KEY ? createAi({ db: ready }) : null;
  const golden = JSON.parse(fs.readFileSync(path.join(root, 'eval', 'kb-golden.json'), 'utf8'));
  const result = await runEval({ kb: createKb({ db: ready, ai, env: process.env }), golden });
  const mode = result.rows.some(r => r.mode === 'hybrid') ? 'hybrid (векторы + слова)' : 'только слова (keyword_only)';
  const date = now().toISOString().slice(0, 10);
  fs.mkdirSync(path.join(root, 'eval', 'reports'), { recursive: true });
  const file = path.join(root, 'eval', 'reports', `kb-${date}.md`);
  fs.writeFileSync(file, renderReport(result, { date, minScore: minScore(process.env), mode }));
  console.log(JSON.stringify(result.metrics), result.pass ? 'PASS' : 'FAIL');
  console.log(`Report: ${path.relative(root, file)}`);
  if (!result.pass) process.exitCode = 1;
} finally { await db.close(); }
