// 09 §4, NFR-COST-04: an unchanged file costs nothing; a changed one re-embeds only its new chunks; a removed file goes;
// without a model the chunks wait without vectors and the next run fills them.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ingest } from '../../server/kb/ingest.js';
import { createTestDb, resetDb } from '../support/db.js';
import { fakeEmbedAi } from './support.js';

let db, root;
const quiet = { warn() {}, info() {}, error() {} };
const sleep = async () => {};
const write = (lang, slug, title, sections) => {
  fs.mkdirSync(path.join(root, lang), { recursive: true });
  fs.writeFileSync(path.join(root, lang, `${slug}.md`),
    `---\ntitle: ${title}\ntopic: t\nupdated: 2026-10-27\n---\n\n${sections.map(([h, t]) => `## ${h}\n${t}\n`).join('\n')}`);
};
const run = (ai, opts = {}) => ingest({ db, ai, root, log: quiet, sleep, ...opts });
const embeddedCount = async () => Number((await db.one('SELECT count(*) AS n FROM kb_chunks WHERE embedding IS NOT NULL')).n);

before(async () => { db = await createTestDb(); });
after(() => db.close());
beforeEach(async () => {
  await resetDb(db);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-'));
  write('ru', 'handover-date', 'Сроки сдачи', [['Когда сдача', 'Дом сдаётся в IV квартале 2027 года.'], ['После сдачи', 'Приёмка идёт 60 дней.']]);
  write('en', 'handover-date', 'Handover dates', [['When', 'The building is handed over in Q4 2027.']]);
});

test('the first run: documents, chunks and vectors (RETRIEVAL_DOCUMENT) are saved', async () => {
  const ai = fakeEmbedAi();
  const r = await run(ai);
  assert.deepEqual([r.documents, r.chunks, r.embedded, r.skipped], [2, 3, 3, 0]);
  assert.equal(ai.batches[0].taskType, 'RETRIEVAL_DOCUMENT');
  assert.match(ai.batches[0].texts[0], /^Сроки сдачи — Когда сдача\n\nДом сдаётся/);
  const doc = await db.one("SELECT * FROM kb_documents WHERE lang = 'ru'");
  assert.equal(doc.slug, 'handover-date');
  assert.equal(doc.topic, 't');
  assert.equal(doc.path, 'kb/ru/handover-date.md');
  assert.equal(await embeddedCount(), 3);
  assert.equal((await db.one('SELECT embed_model FROM kb_chunks LIMIT 1')).embed_model, 'gemini-embedding-001@768');
});

test('NFR-COST-04: the second run with no changes calls no embedding', async () => {
  await run(fakeEmbedAi());
  const ai = fakeEmbedAi();
  const r = await run(ai);
  assert.equal(ai.batches.length, 0);
  assert.deepEqual([r.embedded, r.skipped], [0, 2]);
  assert.equal(await embeddedCount(), 3);
});

test('a changed document: only its new chunk is embedded, the other keeps its vector', async () => {
  await run(fakeEmbedAi());
  write('ru', 'handover-date', 'Сроки сдачи', [['Когда сдача', 'Дом сдаётся в IV квартале 2027 года.'], ['После сдачи', 'Приёмка идёт 45 дней.']]);
  const ai = fakeEmbedAi();
  const r = await run(ai);
  assert.equal(r.embedded, 1);
  assert.equal(ai.batches.length, 1);
  assert.match(ai.batches[0].texts[0], /45 дней/);
  assert.equal((await db.one("SELECT count(*) AS n FROM kb_chunks WHERE lang = 'ru'")).n, 2);
  assert.match((await db.one("SELECT text FROM kb_chunks WHERE lang = 'ru' AND ord = 1")).text, /45/);
  assert.equal(await embeddedCount(), 3);
});

test('a file removed from kb/ goes with its chunks', async () => {
  await run(fakeEmbedAi());
  fs.rmSync(path.join(root, 'en', 'handover-date.md'));
  const r = await run(fakeEmbedAi());
  assert.equal(r.removed, 1);
  assert.equal((await db.one('SELECT count(*) AS n FROM kb_documents')).n, 1);
  assert.equal((await db.one("SELECT count(*) AS n FROM kb_chunks WHERE lang = 'en'")).n, 0);
});

test('09 §4: no model → chunks are saved without vectors; a later run with a model fills only the empty ones', async () => {
  const r = await run(null);
  assert.equal(r.partial, true);
  assert.equal((await db.one('SELECT count(*) AS n FROM kb_chunks')).n, 3);
  assert.equal(await embeddedCount(), 0);
  const r2 = await run(fakeEmbedAi());
  assert.equal(r2.embedded, 3);
  assert.equal(await embeddedCount(), 3);
  assert.equal((await db.one('SELECT count(*) AS n FROM kb_chunks')).n, 3);
});

test('a refusal of the model does not lose the text: the chunks are saved empty, the run reports partial', async () => {
  const r = await run(fakeEmbedAi({ fail: 'rate_minute' }));
  assert.equal(r.partial, true);
  assert.equal((await db.one('SELECT count(*) AS n FROM kb_chunks')).n, 3);
  assert.equal(await embeddedCount(), 0);
});

test('at most a hundred chunks go in a batch; between batches there is a pause', async () => {
  write('ru', 'big', 'Большой', Array.from({ length: 120 }, (_, i) => [`Раздел ${i}`, `Текст раздела номер ${i}.`]));
  const pauses = [];
  const ai = fakeEmbedAi();
  await run(ai, { sleep: async ms => { pauses.push(ms); }, pauseMs: 7 });
  assert.ok(ai.batches.every(b => b.texts.length <= 100));
  assert.ok(ai.batches.length >= 2);
  assert.ok(pauses.includes(7), 'a pause between the batches');
});
