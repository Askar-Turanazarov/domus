// Routing by words without a model (07 §3.4): when the fast chain is empty (06 §16.2) or the router answered badly.
// Roots in three languages; case, ‘ and ' are ignored. Pure.

// The table order is the priority: several matches → the first two.
const ROOTS = [
  ['booking', ['брон', 'заброн', 'показ', 'посмотр вживую', 'band', 'bron', 'koris', 'book', 'viewing']],
  ['finance', ['рассроч', 'ипотек', 'кредит', 'платёж в месяц', 'платеж в месяц', 'взнос', 'muddatli', 'ipoteka', 'tolov',
    'oylik', 'installment', 'mortgage']],
  ['apt_finder', ['квартир', 'комнат', 'этаж', 'м²', 'площад', 'xona', 'kvartira', 'qavat', 'apartment', 'room', 'floor']],
  ['kb_consultant', ['сдач', 'паркинг', 'документ', 'школ', 'садик', 'отделк', 'материал', 'topshir', 'hujjat', 'avtoturargoh',
    'parking', 'deadline', 'school']],
  ['handoff', ['менеджер', 'человек', 'позвон', 'оператор', 'odam', 'menejer', 'qongiroq', 'human', 'call me']]
];

// Roots that only Uzbek has: they settle the language of a Latin message (07 §3.2 `lang`).
const UZ = ['band', 'bron', 'koris', 'muddatli', 'ipoteka', 'tolov', 'oylik', 'xona', 'kvartira', 'qavat', 'topshir', 'hujjat',
  'avtoturargoh', 'odam', 'menejer', 'qongiroq', 'salom', 'rahmat', 'qancha', 'narx', 'uy'];

export const normalise = text => String(text ?? '').toLowerCase().replace(/[‘'`ʻʼ’]/g, '').replace(/\s+/g, ' ').trim();

// → ['booking', 'finance'] (0–2, the table order) and the rest for «Ещё спросить».
export function byWords(text) {
  const s = normalise(text);
  const hit = ROOTS.filter(([, roots]) => roots.some(r => s.includes(r))).map(([agent]) => agent);
  return { agents: hit.slice(0, 2), more: hit.slice(2) };
}

// The language of this message by its letters; unclear → the dialog's language.
export function langOf(text, fallback = 'ru') {
  const s = normalise(text);
  const words = s.split(/[^\p{L}]+/u).filter(Boolean);
  if (!words.length) return fallback;
  if (/[ўқғҳ]/u.test(s)) return 'uz';
  const cyr = words.filter(w => /\p{Script=Cyrillic}/u.test(w)).length;
  const lat = words.length - cyr;
  if (cyr > lat) return 'ru';
  if (lat > cyr) return words.some(w => UZ.some(r => w.startsWith(r))) || /[og]‘|o'|g'/.test(String(text)) ? 'uz' : 'en';
  return fallback;
}

// 07 §3.3: only a greeting or thanks (a dictionary, ≤ 4 words) → smalltalk without the router.
const HELLO = ['привет', 'здравствуйте', 'здравствуй', 'добрый день', 'добрый вечер', 'доброе утро', 'салам', 'салом',
  'ассалому алейкум', 'assalomu alaykum', 'assalomu aleykum', 'salom', 'hello', 'hi', 'hey', 'good morning', 'good afternoon',
  'good evening'];
const THANKS = ['спасибо', 'спасибо большое', 'благодарю', 'рахмат', 'rahmat', 'katta rahmat', 'thanks', 'thank you',
  'thank you very much', 'thx'];

// → 'hello' | 'thanks' | null
export function smalltalkOf(text) {
  const s = normalise(text).replace(/[^\p{L}\s]/gu, '').replace(/\s+/g, ' ').trim();
  if (!s || s.split(' ').length > 4) return null;
  if (HELLO.includes(s)) return 'hello';
  if (THANKS.includes(s)) return 'thanks';
  return null;
}
