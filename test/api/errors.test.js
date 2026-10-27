// 13 §12: every error code has a status and a text in three languages; the statuses are the table of 13 §2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { STATUS } from '../../server/http/common.js';
import { t } from '../../server/i18n/index.js';

const SPEC = path.join(import.meta.dirname, '..', '..', '..', 'docs', 'spec', '13-api.md');

test('every code of the table has err.<code> in ru, uz and en, and a different text per language', () => {
  for (const code of Object.keys(STATUS)) {
    const texts = ['ru', 'uz', 'en'].map(l => t(l, `err.${code}`));
    assert.ok(texts.every(x => typeof x === 'string' && x.trim()), `${code}: a text is missing`);
    assert.equal(new Set(texts).size, 3, `${code}: the texts repeat`);
  }
});

test('the codes and statuses match 13-api.md §2', { skip: !fs.existsSync(SPEC) }, () => {
  const rows = [...fs.readFileSync(SPEC, 'utf8').split('## 3.')[0].matchAll(/^\| `(\w+)` \| (\d{3}) \|/gm)];
  assert.ok(rows.length > 50);
  for (const [, code, status] of rows) assert.equal(STATUS[code], Number(status), code);
});
