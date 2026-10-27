// What never reaches a model (07 §15.1): a phone in the client's text → [телефон] (the number goes to state.contactPhone,
// unverified); a card number (13–19 digits) → [номер карты], and it is not stored either. Pure.
import { normalizePhone } from '../core/phone.js';

const PHONE_MARK = { ru: '[телефон]', uz: '[telefon]', en: '[phone]' };
const CARD_MARK = { ru: '[номер карты]', uz: '[karta raqami]', en: '[card number]' };

// 13–19 digits in a row, single spaces or dashes allowed between them.
const CARD = /(?<![\d+])\d(?:[ -]?\d){12,18}(?!\d)/g;
// +998 90 123 45 67 / 998901234567 / (90) 123-45-67 / 90 123 45 67 / 901234567 / +44 20 7946 0958.
const PHONE = /(?<![\d])(?:\+?998[\s-]?\(?\d{2}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}|\(?\d{2}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}|\+\d(?:[\s-]?\d){7,14})(?![\d])/g;
// A sum is not a phone: 1 000 000 000, «980 000 000 сум».
const MONEY_AFTER = /^\s*(сум|сўм|so[‘'`ʻ]?m|sum|uzs|млн|млрд|mln|mlrd)/i;
const GROUPED_3 = /^\d{1,3}(?: \d{3})+$/;

// → { text, phones: ['+998…'], card: boolean } — the text for the model and the journal, what was taken out.
export function mask(text, lang = 'ru') {
  let card = false;
  let s = String(text ?? '').replace(CARD, m => {
    const d = m.replace(/\D/g, '');
    if (d.length < 13 || d.length > 19 || GROUPED_3.test(m)) return m;
    card = true;
    return CARD_MARK[lang] ?? CARD_MARK.ru;
  });
  const phones = [];
  s = s.replace(PHONE, (m, offset, all) => {
    if (GROUPED_3.test(m) || MONEY_AFTER.test(all.slice(offset + m.length))) return m;
    const p = normalizePhone(m);
    if (!p) return m;
    phones.push(p);
    return PHONE_MARK[lang] ?? PHONE_MARK.ru;
  });
  return { text: s, phones, card };
}

// The stored text of the client's message: the card number is not kept anywhere (§15.1), the phone is.
export const forStorage = (text, lang = 'ru') => String(text ?? '').replace(CARD, m => {
  const d = m.replace(/\D/g, '');
  return d.length >= 13 && d.length <= 19 && !GROUPED_3.test(m) ? (CARD_MARK[lang] ?? CARD_MARK.ru) : m;
});
