// One 404 page for every address that is not a page of the site (14 §2): unknown paths, page templates by their file
// name, staff pages without a session, personal links with a wrong signature or a payment id that does not exist.
// It names nothing about why: a missing page, a hidden one and a broken link look the same.
const TEXT = {
  ru: ['Страница не найдена', 'Такой страницы нет или ссылка устарела.', 'На главную'],
  uz: ['Sahifa topilmadi', 'Bunday sahifa yo‘q yoki havola eskirgan.', 'Bosh sahifaga'],
  en: ['Page not found', 'There is no such page, or the link is out of date.', 'Home']
};

export function notFoundPage(lang = 'ru') {
  const [title, note, home] = TEXT[lang] ?? TEXT.ru;
  return `<!doctype html>
<html lang="${TEXT[lang] ? lang : 'ru'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>404 — ${title}</title>
<style>body{font:16px/1.55 system-ui,sans-serif;max-width:560px;margin:80px auto;padding:0 16px;color:#1b1813;background:#f4efe6;text-align:center}
h1{font-size:48px;margin:0}a{color:#8a5a1c}</style></head>
<body><h1>404</h1><h2>${title}</h2><p>${note}</p><p><a href="/${TEXT[lang] ? lang : 'ru'}">${home}</a></p></body></html>`;
}

export function sendNotFound(req, res) {
  const lang = ['ru', 'uz', 'en'].find(l => l === req.query?.lang) ?? 'ru';
  res.status(404).set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }).type('html').send(notFoundPage(lang));
}
