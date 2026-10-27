// Pages with the language in the address (/ru, /uz, /en, …/building): <html lang>, title and the Open Graph block.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pages from '../server/pages.js';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fsp3d-'));
const { default: app } = await import('../server.js');
const server = app.listen(0);
after(() => server.close());
const base = () => `http://127.0.0.1:${server.address().port}`;
const og = (html, key) => html.match(new RegExp(`<meta property="${key}" content="([^"]*)">`))?.[1];

test('/ru, /uz/, /en, /en/building: the page in that language with its preview', async () => {
  const cases = [['/ru', 'ru', 'planner', ''], ['/uz/', 'uz', 'planner', ''], ['/en', 'en', 'planner', ''],
    ['/en/building', 'en', 'building', '/building'], ['/uz/building/', 'uz', 'building', '/building']];
  for (const [url, lang, page, p] of cases) {
    const res = await fetch(base() + url);
    assert.equal(res.status, 200, url);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, new RegExp(`<html lang="${lang}">`), url);
    assert.equal(og(html, 'og:title'), pages.TEXT[page][lang][0].replace(/"/g, '&quot;'), url);
    assert.equal(og(html, 'og:url'), `${base()}/${lang}${p}`, url);
    assert.equal(og(html, 'og:image'), `${base()}/og/${page}-${lang}.png`, url);
    assert.equal(og(html, 'og:locale'), { ru: 'ru_RU', uz: 'uz_UZ', en: 'en_US' }[lang]);
    assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
    assert.match(html, /href="\/css\/style\.css"/, 'assets are absolute: /en/ does not break them');
  }
});

test('an unknown language is not a page', async () => {
  for (const url of ['/de', '/xx/building', '/en/nope']) assert.notEqual((await fetch(base() + url)).status, 200, url);
});

test('static "/" and "/building.html" are the Russian pages with production URLs', async () => {
  for (const [file, page] of [['index.html', 'planner'], ['building.html', 'building']]) {
    const html = readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
    assert.ok(html.includes(pages.ogBlock(page, 'ru', pages.SITE, pages.STATIC[page])), `${file}: run the block from server/pages.js again`);
    assert.match(html, /<html lang="ru">/);
  }
  // "/" names itself, not /ru: with a foreign og:url / canonical Telegram showed no preview for the bare address.
  const html = await (await fetch(base() + '/')).text();
  assert.equal(og(html, 'og:locale'), 'ru_RU');
  assert.equal(og(html, 'og:url'), base() + '/');
  assert.match(html, new RegExp(`<link rel="canonical" href="${base()}/">`));
});

test('vercel.json ships both pages with the function', () => {
  const v = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  for (const f of ['public/index.html', 'public/building.html']) assert.ok(v.functions['server.js'].includeFiles.includes(f), f);
  // Vercel refuses the whole deploy when a glob is longer than 256 characters
  for (const k of ['includeFiles', 'excludeFiles']) assert.ok(v.functions['server.js'][k].length <= 256, k);
});

test('preview pictures: one per page and language, PNG 1200×630, small enough for messengers', () => {
  for (const page of ['planner', 'building']) {
    for (const lang of pages.LANGS) {
      const png = readFileSync(new URL(`../public/og/${page}-${lang}.png`, import.meta.url));
      assert.equal(png.subarray(1, 4).toString(), 'PNG', `${page}-${lang}`);
      assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 630], `${page}-${lang}`);
      assert.ok(png.length < 1024 * 1024, `${page}-${lang}: ${png.length} bytes`);
    }
  }
});
