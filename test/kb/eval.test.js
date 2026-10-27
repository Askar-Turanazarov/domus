// 09 §8: the golden set — its shape, the metrics on a small base, and the run on the real texts with the fake embeddings.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeClock } from '../../server/core/clock.js';
import { ingest } from '../../server/kb/ingest.js';
import { createKb } from '../../server/kb/retrieve.js';
import { runEval, renderReport, TARGETS } from '../../server/kb/eval.js';
import { createTestDb, resetDb } from '../support/db.js';
import { fakeEmbedAi } from './support.js';

const ROOT = path.join(import.meta.dirname, '..', '..');
const golden = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'kb-golden.json'), 'utf8'));
const quiet = { warn() {}, info() {}, error() {} };

let db;
before(async () => { db = await createTestDb(); });
after(() => db.close());
beforeEach(async () => { await resetDb(db); fakeClock.set('2026-10-28T10:00:00+05:00'); });
afterEach(() => fakeClock.reset());

test('09 §8: the golden set has 30 questions — 20 in the base (7 ru, 7 uz, 6 en) and 10 outside — and every expected document exists', () => {
  assert.equal(golden.length, 30);
  assert.equal(new Set(golden.map(g => g.id)).size, 30);
  const inB = golden.filter(g => g.inBase);
  assert.equal(inB.length, 20);
  assert.deepEqual(['ru', 'uz', 'en'].map(l => inB.filter(g => g.lang === l).length), [7, 7, 6]);
  for (const g of inB) {
    assert.ok(g.expect.length >= 1, g.id);
    for (const slug of g.expect) assert.ok(fs.existsSync(path.join(ROOT, 'kb', g.lang, `${slug}.md`)), `${g.id}: kb/${g.lang}/${slug}.md`);
  }
  assert.ok(golden.filter(g => !g.inBase).every(g => g.expect === undefined));
});

test('09 §8: metrics — hit@3, MRR, refusal precision, false refusals; the journal is not written', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-'));
  fs.mkdirSync(path.join(root, 'ru'), { recursive: true });
  const put = (slug, h, t) => fs.writeFileSync(path.join(root, 'ru', `${slug}.md`), `---\ntitle: ${slug}\ntopic: t\nupdated: 2026-10-27\n---\n\n## ${h}\n${t}\n`);
  put('handover-date', 'Когда сдача дома', 'Дом сдаётся в четвёртом квартале 2027 года.');
  put('parking', 'Подземный паркинг', 'Под домом есть подземный паркинг, места продаются отдельно.');
  await ingest({ db, ai: fakeEmbedAi(), root, log: quiet, sleep: async () => {} });
  const kb = createKb({ db, ai: fakeEmbedAi(), env: { KB_MIN_SCORE: '0.40' }, log: quiet });
  const set = [
    { id: 'a', lang: 'ru', q: 'Когда сдача дома, какой срок сдачи?', inBase: true, expect: ['handover-date'] },
    { id: 'b', lang: 'ru', q: 'Есть ли подземный паркинг?', inBase: true, expect: ['parking'] },
    { id: 'c', lang: 'ru', q: 'Где расположен офис продаж?', inBase: true, expect: ['sales-office'] },
    { id: 'x', lang: 'ru', q: 'Какой вид из окна у квартиры сорок один?', inBase: false },
    { id: 'y', lang: 'ru', q: 'Подземный паркинг продаётся отдельно?', inBase: false }
  ];
  const r = await runEval({ kb, golden: set });
  assert.deepEqual(r.rows.map(x => [x.id, x.answered]), [['a', true], ['b', true], ['c', false], ['x', false], ['y', true]]);
  assert.deepEqual(r.metrics, { hit3: 0.667, mrr: 0.667, refusals: 0.5, falseRefusals: 0.333 });
  assert.equal(r.pass, false);
  assert.equal(r.rows.find(x => x.id === 'a').place, 1);
  assert.equal((await db.query('SELECT 1 FROM kb_queries')).length, 0);

  const md = renderReport(r, { date: '2026-10-28', minScore: 0.4, mode: 'test' });
  assert.match(md, /^# Контрольный набор базы знаний — 2026-10-28/);
  assert.match(md, /\| hit@3 \| 0\.667 \| ≥ 0\.9 \| ✗ \|/);
  assert.match(md, /цели НЕ достигнуты/);
  assert.equal(TARGETS.hit3, 0.9);
});

test('09 §8: the run on the real texts (fake vectors) finishes, every row has a verdict, and nothing is journaled', async () => {
  await ingest({ db, ai: fakeEmbedAi(), root: path.join(ROOT, 'kb'), log: quiet, sleep: async () => {} });
  const kb = createKb({ db, ai: fakeEmbedAi(), env: { KB_MIN_SCORE: '0.40' }, log: quiet });
  const r = await runEval({ kb, golden });
  assert.equal(r.rows.length, 30);
  for (const m of Object.values(r.metrics)) assert.ok(m >= 0 && m <= 1);
  assert.equal((await db.query('SELECT 1 FROM kb_queries')).length, 0);
});
