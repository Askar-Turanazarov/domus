// The call log's result line in all three site languages: { ru, uz, en } per event, so «Журнал вызовов» shows it
// in the page's language. ru is also the plain `msg` (and the text the tools answer with), so it must not drift.
// Pure; no I/O.

const LANGS = ['ru', 'uz', 'en'];
const num = n => Number(n).toLocaleString('ru-RU');
const UNIT = { ru: 'сум', uz: 'so‘m', en: 'sum' };
const money = (lang, n) => `${num(n)} ${UNIT[lang]}`;
const STATUS = {
  ru: { free: 'свободна', booked: 'забронирована', sold: 'продана' },
  uz: { free: 'bo‘sh', booked: 'band qilingan', sold: 'sotilgan' },
  en: { free: 'free', booked: 'booked', sold: 'sold' }
};
const status = (lang, s) => STATUS[lang][s] || s;
const kind = (lang, rooms) => (rooms
  ? { ru: `${rooms}-комн.`, uz: `${rooms} xonali`, en: `${rooms}-room` }[lang]
  : { ru: 'студия', uz: 'studiya', en: 'studio' }[lang]);

// key → { ru, uz, en } of (vars) → text
const TEXT = {
  found: {
    ru: v => `Найдено: ${v.n}`, uz: v => `Topildi: ${v.n}`, en: v => `Found: ${v.n}`
  },
  // get_apartment: №28: 2-комн., 70.7 м², этаж 5, 873 900 000 сум, свободна, 12 360 679 сум/м²
  apt: {
    ru: v => `№${v.no}: ${kind('ru', v.rooms)}, ${v.area} м², этаж ${v.floor}, ${money('ru', v.price)}, ${status('ru', v.status)}${v.perM2 != null ? `, ${money('ru', v.perM2)}/м²` : ''}`,
    uz: v => `№${v.no}: ${kind('uz', v.rooms)}, ${v.area} m², ${v.floor}-qavat, ${money('uz', v.price)}, ${status('uz', v.status)}${v.perM2 != null ? `, ${money('uz', v.perM2)}/m²` : ''}`,
    en: v => `No. ${v.no}: ${kind('en', v.rooms)}, ${v.area} m², floor ${v.floor}, ${money('en', v.price)}, ${status('en', v.status)}${v.perM2 != null ? `, ${money('en', v.perM2)}/m²` : ''}`
  },
  mortgage: {
    ru: v => `Платёж ${money('ru', v.monthly)} в месяц, переплата ${money('ru', v.overpay)}`,
    uz: v => `Oylik to‘lov ${money('uz', v.monthly)}, ortiqcha to‘lov ${money('uz', v.overpay)}`,
    en: v => `Monthly payment ${money('en', v.monthly)}, overpayment ${money('en', v.overpay)}`
  },
  booked: {
    ru: v => `Записано на показ: квартира №${v.no}, ${v.when}`,
    uz: v => `Ko‘rishga yozildi: №${v.no} kvartira, ${v.when}`,
    en: v => `Viewing booked: apartment No. ${v.no}, ${v.when}`
  },
  notFound: {
    ru: v => `Квартира №${v.no} не найдена${v.hint ? '. Номера квартир можно найти через search_apartments' : ''}`,
    uz: v => `№${v.no} kvartira topilmadi${v.hint ? '. Kvartira raqamlarini search_apartments orqali topish mumkin' : ''}`,
    en: v => `Apartment No. ${v.no} not found${v.hint ? '. Apartment numbers can be found with search_apartments' : ''}`
  },
  sold: {
    ru: v => `Квартира №${v.no} продана, запись на показ невозможна`,
    uz: v => `№${v.no} kvartira sotilgan, ko‘rishga yozilib bo‘lmaydi`,
    en: v => `Apartment No. ${v.no} is sold, a viewing cannot be booked`
  },
  phone: {
    ru: () => 'Телефон в неверном формате, например +998 90 123 45 67',
    uz: () => 'Telefon raqami noto‘g‘ri formatda, masalan +998 90 123 45 67',
    en: () => 'The phone number has a wrong format, e.g. +998 90 123 45 67'
  },
  dateFormat: {
    ru: () => 'Дата и время в формате 2026-10-25T15:00 (время Ташкента)',
    uz: () => 'Sana va vaqt 2026-10-25T15:00 formatida (Toshkent vaqti)',
    en: () => 'Date and time as 2026-10-25T15:00 (Tashkent time)'
  },
  past: {
    ru: () => 'Дата и время показа должны быть в будущем',
    uz: () => 'Ko‘rish sanasi va vaqti kelajakda bo‘lishi kerak',
    en: () => 'The viewing date and time must be in the future'
  },
  taken: {
    ru: v => `Это время занято: на ${v.when} (Ташкент) на квартиру №${v.no} уже есть запись. Выберите другое время`,
    uz: v => `Bu vaqt band: №${v.no} kvartiraga ${v.when} (Toshkent) uchun yozilish bor. Boshqa vaqtni tanlang`,
    en: v => `This time is taken: apartment No. ${v.no} already has a viewing at ${v.when} (Tashkent). Choose another time`
  },
  internal: {
    ru: () => 'Внутренняя ошибка сервера, попробуйте позже',
    uz: () => 'Serverning ichki xatosi, keyinroq urinib ko‘ring',
    en: () => 'Internal server error, please try later'
  },
  oneOf: {
    ru: () => 'Укажите что-то одно: сумму кредита (loan), цену (price) или номер квартиры (no)',
    uz: () => 'Faqat bittasini kiriting: kredit summasi (loan), narx (price) yoki kvartira raqami (no)',
    en: () => 'Give exactly one: the loan amount (loan), the price (price) or the apartment number (no)'
  },
  downWithLoan: {
    ru: () => 'Взнос (downPct) указывается с ценой (price) или номером (no), а не с суммой кредита',
    uz: () => 'Boshlang‘ich to‘lov (downPct) kredit summasi bilan emas, narx (price) yoki raqam (no) bilan beriladi',
    en: () => 'The down payment (downPct) goes with the price (price) or the number (no), not with a loan amount'
  },
  badParams: {
    ru: () => 'Неверные параметры: вызов отклонён до инструмента',
    uz: () => 'Noto‘g‘ri parametrlar: chaqiruv asbobgacha rad etildi',
    en: () => 'Invalid parameters: the call was refused before the tool'
  }
};

// (key, vars) → { ru, uz, en }; an unknown key → null.
export function logTexts(key, vars = {}) {
  const t = TEXT[key];
  return t ? Object.fromEntries(LANGS.map(l => [l, t[l](vars)])) : null;
}

export const ruText = (key, vars) => logTexts(key, vars).ru;

// Lines logged before msgs existed hold Russian only: read them back into { key, vars }.
const sumRe = '([\\d\\s\\u00a0\\u202f]+) сум';
const int = s => Number(String(s).replace(/\D/g, ''));
const LEGACY = [
  [/^Найдено: (\d+)$/, m => ['found', { n: +m[1] }]],
  [new RegExp(`^№(\\d+): (?:(\\d+)-комн\\.|студия), ([\\d.]+) м², этаж (\\d+), ${sumRe}, ([^,]+)(?:, ${sumRe}/м²)?$`),
    m => ['apt', { no: +m[1], rooms: m[2] ? +m[2] : 0, area: +m[3], floor: +m[4], price: int(m[5]),
      status: Object.keys(STATUS.ru).find(k => k === m[6] || STATUS.ru[k] === m[6]) || m[6], perM2: m[7] ? int(m[7]) : undefined }]],
  [new RegExp(`^Платёж ${sumRe} в месяц, переплата ${sumRe}$`), m => ['mortgage', { monthly: int(m[1]), overpay: int(m[2]) }]],
  [/^Записано на показ: квартира №(\d+), (.+)$/, m => ['booked', { no: +m[1], when: m[2] }]],
  [/^Квартира №(\d+) не найдена(\. Номера)?/, m => ['notFound', { no: +m[1], hint: !!m[2] }]],
  [/^Квартира №(\d+) продана/, m => ['sold', { no: +m[1] }]],
  [/^Это время занято: на (.+) \(Ташкент\) на квартиру №(\d+)/, m => ['taken', { when: m[1], no: +m[2] }]]
];
const FIXED = ['phone', 'dateFormat', 'past', 'internal', 'oneOf', 'downWithLoan', 'badParams'];

// A Russian log line → { ru, uz, en }, or null when it is not one of ours (then the page shows msg as is).
export function fromLegacy(msg) {
  if (typeof msg !== 'string') return null;
  for (const [re, read] of LEGACY) {
    const m = re.exec(msg);
    if (m) return logTexts(...read(m));
  }
  const key = FIXED.find(k => TEXT[k].ru() === msg);
  return key ? logTexts(key) : null;
}
