// Server texts (13 §2, 05 §9): server/i18n/{ru,uz,en}.json, keys like 'pay.reason.bank_declined'. Uzbek is checked by the author.
import fs from 'node:fs';

const LANGS = ['ru', 'uz', 'en'];
const dict = Object.fromEntries(LANGS.map(l => [l, JSON.parse(fs.readFileSync(new URL(`./${l}.json`, import.meta.url), 'utf8'))]));

// t('en', 'pay.form.wrong_code', {left: 2}) → the text; an unknown language falls back to ru, an unknown key → null.
export function t(lang, key, vars = {}) {
  const text = dict[LANGS.includes(lang) ? lang : 'ru'][key] ?? dict.ru[key];
  return text == null ? null : text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

// The reason text of a failed or cancelled payment (05 §9); 'replaced' is never shown → null.
export const failureText = (reason, lang) => (reason ? t(lang, `pay.reason.${reason}`) : null);
