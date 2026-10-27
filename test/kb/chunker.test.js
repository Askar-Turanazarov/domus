// 09 §3: sections by `##`, long sections in parts with an overlap of one sentence, the heading with the title, the hash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDoc, sections, splitText, chunkDocument, sha256, MAX_CHARS } from '../../server/kb/chunker.js';

const DOC = `---
title: Сроки сдачи
topic: handover
updated: 2026-10-27
---

## Когда сдача дома
Дом сдаётся в IV квартале 2027 года.

## Что после сдачи
Приёмка квартир идёт 60 дней.
`;

test('09 §2.1: frontmatter is «key: value» lines; the body follows', () => {
  const { meta, body } = parseDoc(DOC);
  assert.deepEqual(meta, { title: 'Сроки сдачи', topic: 'handover', updated: '2026-10-27' });
  assert.match(body, /^\s*## Когда сдача дома/);
  assert.deepEqual(parseDoc('no frontmatter').meta, {});
  assert.equal(parseDoc('\uFEFF---\r\ntitle: A\r\n---\r\n## x\r\ny').meta.title, 'A');
});

test('09 §3: a chunk per `##` section, heading = «title — section», the embedding text is heading + blank line + text', () => {
  const { chunks, meta } = chunkDocument(DOC, 'handover-date');
  assert.equal(meta.topic, 'handover');
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].heading, 'Сроки сдачи — Когда сдача дома');
  assert.equal(chunks[0].text, 'Дом сдаётся в IV квартале 2027 года.');
  assert.equal(chunks[0].embedText, 'Сроки сдачи — Когда сдача дома\n\nДом сдаётся в IV квартале 2027 года.');
  assert.equal(chunks[0].hash, sha256(chunks[0].embedText));
  assert.deepEqual(chunks.map(c => c.ord), [0, 1]);
});

test('09 §3: text before the first `##` is a chunk named after the title; empty sections are dropped; no title → the slug', () => {
  const { chunks } = chunkDocument('---\ntitle: T\n---\nIntro text.\n\n## Empty\n\n## Full\nBody.', 'x');
  assert.deepEqual(chunks.map(c => c.heading), ['T', 'T — Full']);
  assert.equal(chunkDocument('## A\nb', 'my-slug').chunks[0].heading, 'my-slug — A');
});

test('09 §3: a section over 900 characters is cut by sentences; every part fits; the next part begins with the last sentence', () => {
  const sentence = n => `Sentence number ${n} says something rather long about the apartment building and its yard.`;
  const text = Array.from({ length: 30 }, (_, i) => sentence(i)).join(' ');
  assert.ok(text.length > 2 * MAX_CHARS);
  const parts = splitText(text);
  assert.ok(parts.length >= 3);
  assert.ok(parts.every(p => p.length <= MAX_CHARS));
  for (let i = 1; i < parts.length; i++) {
    const last = parts[i - 1].split(/(?<=[.!?…])\s+/).at(-1);
    assert.ok(parts[i].startsWith(last), `part ${i} starts with the end of part ${i - 1}`);
  }
  assert.ok(parts.join(' ').includes(sentence(29)), 'nothing is lost');
});

test('09 §3: paragraphs stay paragraphs; one sentence longer than a part is cut hard; a short text is one part', () => {
  assert.deepEqual(splitText('Short.'), ['Short.']);
  const long = 'x'.repeat(2000);
  const parts = splitText(long);
  assert.ok(parts.length >= 3 && parts.every(p => p.length <= MAX_CHARS));
  const two = splitText(`${'Alpha one. '.repeat(50)}\n\n${'Beta two. '.repeat(50)}`);
  assert.ok(two.some(p => p.includes('\n\n')), 'a blank line between paragraphs survives inside a part');
});

test('09 §3: the parts of a long section are chunks with the same heading and consecutive ord', () => {
  const body = `## Big\n${Array.from({ length: 40 }, (_, i) => `Fact ${i} is stated here in a full sentence.`).join(' ')}`;
  const { chunks } = chunkDocument(`---\ntitle: Doc\n---\n${body}`);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every(c => c.heading === 'Doc — Big'));
  assert.deepEqual(chunks.map(c => c.ord), chunks.map((_, i) => i));
  assert.equal(new Set(chunks.map(c => c.hash)).size, chunks.length);
});

test('sections(): a `###` line is not a section', () => {
  assert.equal(sections('## A\nx\n### B\ny', 'T').length, 1);
});
