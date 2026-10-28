// The pages behind a personal link or a payment id (11 §2): the booking page /b/:ref, the order page /o/:ref (S) and the emulators /pay/card|click/:id.
// They are never cached, never indexed and never leak the address in a Referer (03 §14). The page itself carries nothing
// personal: the client script asks the API with the link. Also /legal/:doc (11 §9): the files legal/<doc>.<lang>.html
// (D5-07); a missing file — a short stub.
import fs from 'node:fs';
import path from 'node:path';
import { langOf } from './common.js';

const LANGS = ['ru', 'uz', 'en'];
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

const STUB = {
  ru: { offer: 'Публичная оферта', privacy: 'Политика конфиденциальности', back: 'К витрине дома',
    note: 'Учебный проект. Документ составлен для дипломной работы и не является публичной офертой реальной компании. Полный текст будет опубликован здесь.' },
  uz: { offer: 'Ommaviy oferta', privacy: 'Maxfiylik siyosati', back: 'Uy vitrinasiga',
    note: 'O‘quv loyihasi. Hujjat diplom ishi uchun tuzilgan va haqiqiy kompaniyaning ommaviy ofertasi hisoblanmaydi. To‘liq matn shu yerda e’lon qilinadi.' },
  en: { offer: 'Public offer', privacy: 'Privacy policy', back: 'Back to the building',
    note: 'A training project. The document was written for a diploma work and is not a public offer of a real company. The full text will be published here.' }
};

const stubPage = (doc, lang) => `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(STUB[lang][doc])} — Chinor Park</title>
<style>body{font:16px/1.55 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#1b1813;background:#f4efe6}
.note{background:#fbf3df;border:1px solid #d9a650;border-radius:8px;padding:10px 14px}</style></head>
<body><h1>${esc(STUB[lang][doc])}</h1><p class="note">${esc(STUB[lang].note)}</p><p><a href="/${lang}">${esc(STUB[lang].back)}</a></p></body></html>`;

// opts.publicDir — where the .html templates are; opts.legalDir — legal/.
export function mountPersonalPages(app, { publicDir, legalDir }) {
  const cache = new Map();   // on Vercel the files never change; locally an edited page is read again
  const read = file => {
    const full = path.join(publicDir, file);
    if (!cache.has(full) || !process.env.VERCEL) cache.set(full, fs.readFileSync(full, 'utf8'));
    return cache.get(full);
  };
  const send = file => (req, res) => {
    const lang = LANGS.includes(req.query.lang) ? req.query.lang : null;
    const html = read(file);
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' }).type('html')
      .send(lang ? html.replace(/<html lang="[a-z]+">/, `<html lang="${lang}">`) : html);
  };
  app.get('/b/:ref', send('booking.html'));
  app.get('/o/:ref', send('order.html'));
  app.get('/pay/card/:id', send('pay-card.html'));
  app.get('/pay/click/:id', send('pay-click.html'));

  app.get('/legal/:doc(offer|privacy)', (req, res) => {
    const lang = langOf(req), doc = req.params.doc;
    const file = path.join(legalDir, `${doc}.${lang}.html`);
    res.set({ 'Cache-Control': 'public, max-age=3600' }).type('html').send(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : stubPage(doc, lang));
  });
}
