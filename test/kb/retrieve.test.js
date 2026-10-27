// 09 §5, §9: RRF, the threshold, keyword_only, the language filter, transliteration, the journal kb_queries.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeClock } from '../../server/core/clock.js';
import { ingest } from '../../server/kb/ingest.js';
import { createKb } from '../../server/kb/retrieve.js';
import { uzToLatin, prepare, tsOr } from '../../server/kb/text.js';
import { createTestDb, resetDb } from '../support/db.js';
import { fakeEmbedAi } from './support.js';

let db, root;
const quiet = { warn() {}, info() {}, error() {} };
const doc = (lang, slug, title, sections) => {
  fs.mkdirSync(path.join(root, lang), { recursive: true });
  fs.writeFileSync(path.join(root, lang, `${slug}.md`),
    `---\ntitle: ${title}\ntopic: t\nupdated: 2026-10-27\n---\n\n${sections.map(([h, t]) => `## ${h}\n${t}\n`).join('\n')}`);
};

before(async () => { db = await createTestDb(); });
after(() => db.close());
beforeEach(async () => {
  await resetDb(db);
  fakeClock.set('2026-10-28T10:00:00+05:00');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-'));
  doc('ru', 'handover-date', 'Сроки сдачи', [['Когда сдача дома', 'Дом сдаётся в четвёртом квартале 2027 года. Срок ориентировочный.']]);
  doc('ru', 'parking', 'Паркинг', [['Подземный паркинг', 'Под домом есть подземный паркинг. Места продаются отдельно от квартир.']]);
  doc('ru', 'sales-office', 'Офис продаж', [['Часы работы', 'Офис работает с понедельника по субботу с девяти до восемнадцати часов.']]);
  doc('en', 'parking', 'Parking', [['Underground parking', 'The building has underground parking. Spaces are sold separately from apartments.']]);
  doc('uz', 'handover-date', 'Topshirish muddatlari', [['Uy qachon topshiriladi', 'Uy 2027-yilning to‘rtinchi choragida topshiriladi.']]);
  await ingest({ db, ai: fakeEmbedAi(), root, log: quiet, sleep: async () => {} });
});
afterEach(() => fakeClock.reset());

// the fake model is far cruder than a real one: its cosines are lower, so the threshold is lowered for it
const kbWith = (ai = fakeEmbedAi(), env = { KB_MIN_SCORE: '0.40' }) => createKb({ db, ai, env, log: quiet });

test('09 §5.2: a question close to a chunk → answered, the nearest chunk first, with the score and the document', async () => {
  const r = await kbWith().retrieve({ query: 'Когда сдача дома, какой срок сдачи?', lang: 'ru' });
  assert.equal(r.answered, true);
  assert.equal(r.mode, 'hybrid');
  assert.equal(r.chunks[0].doc, 'handover-date');
  assert.equal(r.chunks[0].n, 1);
  assert.ok(r.chunks[0].score > 0.4);
  assert.match(r.chunks[0].heading, /^Сроки сдачи — /);
  assert.ok(r.chunks.length <= 4);
});

test('09 §5.2: the language filter — a Russian question never returns the English or Uzbek chunks', async () => {
  const r = await kbWith().retrieve({ query: 'подземный паркинг', lang: 'ru' });
  assert.equal(r.answered, true);
  assert.ok(r.chunks.every(c => /[а-я]/i.test(c.heading)));
  const en = await kbWith().retrieve({ query: 'underground parking', lang: 'en' });
  assert.equal(en.chunks[0].doc, 'parking');
  assert.ok(en.chunks.every(c => !/[а-я]/i.test(c.heading)));
});

test('09 §5.3: a question far from everything → «below_threshold», no chunks', async () => {
  const r = await kbWith().retrieve({ query: 'Какой вид из окна у квартиры сорок один?', lang: 'ru' });
  assert.deepEqual([r.answered, r.reason], [false, 'below_threshold']);
  assert.equal(r.chunks, undefined);
});

test('09 §5.3: the threshold is KB_MIN_SCORE of the environment', async () => {
  const q = { query: 'подземный паркинг продаётся', lang: 'ru' };
  assert.equal((await kbWith(fakeEmbedAi(), { KB_MIN_SCORE: '0.30' }).retrieve(q)).answered, true);
  assert.equal((await kbWith(fakeEmbedAi(), { KB_MIN_SCORE: '0.99' }).retrieve(q)).answered, false);
});

test('09 §5.2: RRF — a chunk found by the words joins the result', async () => {
  const r = await kbWith().retrieve({ query: 'Офис работает по субботам?', lang: 'ru' });
  assert.equal(r.answered, true);
  assert.ok(r.chunks.some(c => c.doc === 'sales-office'));
});

test('09 §5.4: no embeddings (the model fails) → keyword_only; 2+ significant words answer, one does not', async () => {
  const kb = kbWith(fakeEmbedAi({ fail: 'server' }));
  const ok = await kb.retrieve({ query: 'Где находится подземный паркинг?', lang: 'ru' });
  assert.deepEqual([ok.answered, ok.mode], [true, 'keyword_only']);
  assert.equal(ok.chunks[0].doc, 'parking');
  assert.equal(ok.chunks[0].score, null);
  assert.equal((await kb.retrieve({ query: 'паркинг красивый', lang: 'ru' })).answered, false);
  const none = await kb.retrieve({ query: 'вид из окна', lang: 'ru' });
  assert.deepEqual([none.answered, none.mode], [false, 'keyword_only']);
});

test('09 §5.4: no AI at all → keyword_only as well', async () => {
  const r = await createKb({ db, ai: null, log: quiet }).retrieve({ query: 'подземный паркинг продаётся отдельно', lang: 'ru' });
  assert.deepEqual([r.answered, r.mode], [true, 'keyword_only']);
});

test('09 §5.1: Uzbek in Cyrillic is turned to Latin before the search', async () => {
  assert.equal(uzToLatin('Қачон топширилади'), 'Qachon topshiriladi');
  assert.equal(uzToLatin('Ўзбекистон, шаҳар, ғалла, ёш, юз, яхши'), 'O‘zbekiston, shahar, g‘alla, yosh, yuz, yaxshi');
  const r = await createKb({ db, ai: null, log: quiet }).retrieve({ query: 'Уй тўртинчи чоракда топширилади?', lang: 'uz' });
  assert.equal(r.answered, true);
  assert.equal(r.chunks[0].doc, 'handover-date');
  assert.equal(prepare('Уй қачон топширилади', 'ru').text, 'Уй қачон топширилади', 'only Uzbek is transliterated');
});

test('09 §5.1: the query is cut to 500 characters; the stems are safe for tsquery (no quotes, no operators)', () => {
  assert.equal(prepare('а'.repeat(900), 'ru').text.length, 500);
  const { stems } = prepare('паркинг\'; DROP TABLE x; -- & | ! ( ) :* "', 'ru');
  assert.ok(stems.every(s => /^[\p{L}\p{N}]+$/u.test(s)));
  assert.equal(tsOr(['парк', 'сдач']), "'парк':* | 'сдач':*");
});

test('09 §5.5: every search is a row of kb_queries (mode, best score, chunks, answered, time of the core clock)', async () => {
  const kb = kbWith();
  await kb.retrieve({ query: 'подземный паркинг', lang: 'ru' });
  await kb.retrieve({ query: 'Какой вид из окна?', lang: 'ru' });
  const rows = await db.query('SELECT * FROM kb_queries ORDER BY id');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.answered), [true, false]);
  assert.equal(rows[0].mode, 'hybrid');
  assert.equal(rows[0].lang, 'ru');
  assert.ok(rows[0].chunk_ids.length >= 1);
  assert.ok(rows[0].top_score > 0);
  assert.equal(new Date(rows[0].at).toISOString(), '2026-10-28T05:00:00.000Z');
});

test('06 §13: the vector of a question is remembered — the same question does not call the model again', async () => {
  const ai = fakeEmbedAi();
  const kb = kbWith(ai);
  await kb.retrieve({ query: 'подземный паркинг', lang: 'ru' });
  await kb.retrieve({ query: 'Подземный  паркинг', lang: 'ru' });
  assert.equal(ai.batches.length, 1);
  assert.equal(ai.batches[0].taskType, 'RETRIEVAL_QUERY');
});
