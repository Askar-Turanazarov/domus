// The call log's result line in ru / uz / en, and reading back the lines logged in Russian only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logTexts, fromLegacy } from '../../server/tools/logText.js';

const VARS = { n: 2, no: 28, rooms: 2, area: 70.7, floor: 5, price: 873_900_000, status: 'free', perM2: 12_360_679,
  monthly: 9_879_714, overpay: 1_298_348_431, when: '2026-10-22 15:00', hint: true };
const KEYS = ['found', 'apt', 'mortgage', 'booked', 'notFound', 'sold', 'phone', 'dateFormat', 'past', 'taken', 'internal', 'oneOf', 'downWithLoan', 'badParams'];

test('every key has three different, non-empty texts', () => {
  for (const key of KEYS) {
    const m = logTexts(key, VARS);
    assert.deepEqual(Object.keys(m), ['ru', 'uz', 'en'], key);
    assert.ok(m.ru && m.uz && m.en, key);
    assert.notEqual(m.ru, m.en, key);
    assert.notEqual(m.uz, m.en, key);
  }
  assert.equal(logTexts('nope'), null);
});

const plain = m => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.replace(/\s/g, ' ')]));   // toLocaleString groups with U+202F

test('the apartment line: status in words, price per m²', () => {
  const m = plain(logTexts('apt', VARS));
  assert.equal(m.ru, '№28: 2-комн., 70.7 м², этаж 5, 873 900 000 сум, свободна, 12 360 679 сум/м²');
  assert.equal(m.uz, '№28: 2 xonali, 70.7 m², 5-qavat, 873 900 000 so‘m, bo‘sh, 12 360 679 so‘m/m²');
  assert.equal(m.en, 'No. 28: 2-room, 70.7 m², floor 5, 873 900 000 sum, free, 12 360 679 sum/m²');
});

test('every Russian line reads back to the same three texts', () => {
  for (const key of KEYS) {
    const m = logTexts(key, VARS);
    assert.deepEqual(fromLegacy(m.ru), m, key);
  }
});

test('old lines: the raw status word, a line that is not ours', () => {
  assert.equal(plain(fromLegacy('№77: 2-комн., 68.5 м², этаж 11, 896 000 000 сум, free, 13 080 292 сум/м²')).en,
    'No. 77: 2-room, 68.5 m², floor 11, 896 000 000 sum, free, 13 080 292 sum/m²');
  assert.equal(fromLegacy('что-то другое'), null);
  assert.equal(fromLegacy(undefined), null);
});
