// RU / UZ / EN texts (15 §2.4): the client dictionary and the server texts have the same keys everywhere, no empty
// strings and no string equal to its key, the same {placeholders} in every language, Uzbek with ‘ (U+2018) and not ' or `,
// a text for every error code (13 §2). Templates are checked in events/templates.test.js. The offer and the privacy
// policy (11 §9) open in three languages with the training-project note and the edition.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dict } from '../public/js/i18n.js';
import { STATUS } from '../server/http/common.js';

const LANGS = ['ru', 'uz', 'en'];
const server = Object.fromEntries(LANGS.map(l => [l, JSON.parse(fs.readFileSync(new URL(`../server/i18n/${l}.json`, import.meta.url), 'utf8'))]));
const BOTH = { client: dict, server };
const holes = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');

for (const [name, d] of Object.entries(BOTH)) {
  test(`i18n ${name}: every language has exactly the keys of the others`, () => {
    const all = new Set(LANGS.flatMap(l => Object.keys(d[l])));
    for (const l of LANGS) {
      const missing = [...all].filter(k => !(k in d[l]));
      assert.deepEqual(missing, [], `${l} has no translation for: ${missing.join(', ')}`);
    }
  });

  test(`i18n ${name}: no empty strings and no string equal to its key`, () => {
    for (const l of LANGS) {
      const bad = Object.entries(d[l]).filter(([k, v]) => typeof v !== 'string' || !v.trim() || v === k).map(([k]) => k);
      assert.deepEqual(bad, [], `${l}: empty or untranslated ${bad.join(', ')}`);
    }
  });

  test(`i18n ${name}: the same {placeholders} in ru, uz and en`, () => {
    const bad = Object.keys(d.ru).filter(k => LANGS.some(l => typeof d[l][k] === 'string' && holes(d[l][k]) !== holes(d.ru[k])));
    assert.deepEqual(bad, [], `placeholders differ: ${bad.join(', ')}`);
  });

  test(`i18n ${name}: Uzbek writes o‘ / g‘ with U+2018, not ' or \``, () => {
    const bad = Object.entries(d.uz).filter(([, v]) => /[oOgG]['`ʻ]|[og]’/.test(v)).map(([k]) => k);
    assert.deepEqual(bad, [], `uz apostrophe: ${bad.join(', ')}`);
  });
}

test('i18n: every error code of 13 §2 has a text in three languages', () => {
  const missing = Object.keys(STATUS).flatMap(code => LANGS.filter(l => !server[l][`err.${code}`]).map(l => `${l}:${code}`));
  assert.deepEqual(missing, []);
});

test('11 §9: the offer and the privacy policy exist in three languages — the note, the edition, no scripts', () => {
  const NOTE = { ru: 'Учебный проект', uz: 'O‘quv loyihasi', en: 'A training project' };
  const EDITION = { ru: 'Редакция от 27.10.2026', uz: '27.10.2026', en: '27.10.2026' };
  for (const doc of ['offer', 'privacy']) for (const l of LANGS) {
    const html = fs.readFileSync(new URL(`../legal/${doc}.${l}.html`, import.meta.url), 'utf8');
    assert.match(html, new RegExp(`<html lang="${l}">`), `${doc}.${l}`);
    assert.ok(html.includes(NOTE[l]) && html.includes(EDITION[l]), `${doc}.${l}: the note and the edition`);
    assert.doesNotMatch(html, /<script/i, `${doc}.${l}: no scripts`);
    assert.doesNotMatch(html, /\[проверить|TODO|\{\w+\}/, `${doc}.${l}: no draft marks`);
  }
});
