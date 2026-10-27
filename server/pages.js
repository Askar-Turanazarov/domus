// Pages with a language in the address (/ru, /uz, /en, /en/building): the same HTML with <html lang>, <title> and the
// Open Graph block (link previews in Telegram, WhatsApp, Facebook…) in that language. The static files carry the Russian
// block with production URLs, so "/" and "/building.html" are the Russian pages; each names itself in og:url.
import fs from 'node:fs';
import path from 'node:path';

const LANGS = ['ru', 'uz', 'en'];
const STATIC = { planner: '/', building: '/building.html' };   // the addresses without a language
const SITE = 'https://3d-furniture-studio-mcp.vercel.app';
const LOCALE = { ru: 'ru_RU', uz: 'uz_UZ', en: 'en_US' };
const PAGES = {
  planner: { file: 'index.html', path: '', image: 'planner' },
  building: { file: 'building.html', path: '/building', image: 'building' }
};
const TEXT = {
  planner: {
    ru: ['Domus — квартиры и мебель в 3D',
      'Задайте размеры комнат и мебели, проверьте, что поместится, пройдитесь по квартире в 3D и оставьте заявку.'],
    uz: ['Domus — kvartiralar va mebel 3D’da',
      'Xona va mebel o‘lchamlarini kiriting, nima sig‘ishini tekshiring, kvartirani 3D’da aylanib chiqing va ariza qoldiring.'],
    en: ['Domus — apartments and furniture in 3D',
      'Set room and furniture sizes, check what fits, walk through the apartment in 3D and send a request.']
  },
  building: {
    ru: ['ЖК «Новостройка-12» — квартиры с планировкой и прогулкой в 3D',
      'Подбор квартиры по комнатам, площади и цене, план этажа и прогулка от улицы до квартиры в 3D.'],
    uz: ['«Novostroyka-12» TJM — rejali va 3D sayrli kvartiralar',
      'Kvartirani xonalar, maydon va narx bo‘yicha tanlash, qavat rejasi va ko‘chadan kvartiragacha 3D sayr.'],
    en: ['Novostroyka-12 — apartments with floor plans and a 3D walk',
      'Pick an apartment by rooms, area and price, see the floor plan and walk from the street to the door in 3D.']
  }
};

const esc = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// The <head> block between <!--og--> and <!--/og-->. `self` is the page's own address: og:url and canonical must name
// the very link that was shared, otherwise Telegram shows no preview for "/" (it pointed to /ru).
function ogBlock(page, lang, origin = SITE, self = `/${lang}${PAGES[page].path}`) {
  const p = PAGES[page];
  const [title, description] = TEXT[page][lang];
  const url = origin + self;
  const meta = (attr, key, value) => `  <meta ${attr}="${key}" content="${esc(value)}">`;
  return [
    '<!--og-->',
    meta('name', 'description', description),
    `  <link rel="canonical" href="${esc(url)}">`,
    ...LANGS.map(l => `  <link rel="alternate" hreflang="${l}" href="${esc(`${origin}/${l}${p.path}`)}">`),
    `  <link rel="alternate" hreflang="x-default" href="${esc(origin + (p.path ? '/building.html' : '/'))}">`,
    meta('property', 'og:type', 'website'),
    meta('property', 'og:site_name', 'Domus'),
    meta('property', 'og:title', title),
    meta('property', 'og:description', description),
    meta('property', 'og:url', url),
    meta('property', 'og:image', `${origin}/og/${p.image}-${lang}.png`),
    meta('property', 'og:image:width', '1200'),
    meta('property', 'og:image:height', '630'),
    meta('property', 'og:locale', LOCALE[lang]),
    ...LANGS.filter(l => l !== lang).map(l => meta('property', 'og:locale:alternate', LOCALE[l])),
    meta('name', 'twitter:card', 'summary_large_image'),
    '  <!--/og-->'
  ].join('\n');
}

const cache = new Map();   // on Vercel the files never change; locally an edited page is read again
function render(page, lang, origin = SITE, self = undefined, publicDir = path.join(import.meta.dirname, '..', 'public')) {
  const file = path.join(publicDir, PAGES[page].file);
  if (!cache.has(file) || !process.env.VERCEL) cache.set(file, fs.readFileSync(file, 'utf8'));
  return cache.get(file)
    .replace(/<html lang="[a-z]+">/, `<html lang="${lang}">`)
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(TEXT[page][lang][0])}</title>`)
    .replace(/<!--og-->[\s\S]*?<!--\/og-->/, ogBlock(page, lang, origin, self));
}

export { LANGS, SITE, STATIC, PAGES, TEXT, ogBlock, render };
