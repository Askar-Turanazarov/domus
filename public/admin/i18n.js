// Admin texts (12 §1). The interface language is the staff member's own (staff.lang), switchable in the header; Uzbek is Latin.
// Sections add their own texts next to their screens: addTexts({ ru: {...}, en: {...}, uz: {...} }).
const KEY = 'domus.adm.lang';
export const LANGS = ['ru', 'uz', 'en'];

const dict = {
  ru: {
    'unit.sum': 'сум', 'left.min': '{n} мин', 'left.h': '{n} ч', 'left.dh': '{d} д {h} ч',
    'app.loading': 'Загрузка…', 'app.fail': 'Не получилось загрузить. Повторим автоматически',
    'login.title': 'Вход для сотрудников', 'login.login': 'Логин', 'login.password': 'Пароль', 'login.submit': 'Войти', 'login.busy': 'Входим…',
    'nav.logout': 'Выйти', 'nav.theme': 'Тема', 'nav.units': 'Шахматка', 'nav.inbox': 'С менеджером', 'nav.notfound': 'Раздел не найден',
    'role.manager': 'Менеджер', 'role.head': 'Руководитель',
    'tg.warn': 'Привяжите Telegram, чтобы брать клиентов из группы',
    'st.free': 'Свободна', 'st.held': 'Идёт оформление', 'st.booked': 'Забронирована', 'st.sold': 'Продана',
    'bk.held': 'Ждёт оплаты', 'bk.booked': 'Забронирована', 'bk.hold_expired': 'Удержание истекло', 'bk.released': 'Снята клиентом',
    'bk.expired': 'Бронь истекла', 'bk.cancelled': 'Отменена', 'bk.converted': 'Продана',
    'units.title': 'Шахматка', 'units.status': 'Статус', 'units.rooms': 'Комнаты', 'units.floor': 'Этаж', 'units.all': 'Все',
    'units.studio': 'Студия', 'units.roomsN': '{n} комн.', 'units.soon': 'Сгорает за 24 ч', 'units.reset': 'Сбросить',
    'units.floorN': '{n} эт.', 'units.count': 'Показано {n} из {all}', 'units.legend': 'Обновляется каждые 5 с', 'units.empty': 'Квартир нет',
    'units.updated': 'Обновлено {time}', 'units.pick': 'Выберите квартиру на шахматке', 'units.floorLabel': 'Этаж {n}',
    'apt.title': 'Квартира №{no}', 'apt.close': 'Закрыть', 'apt.area': 'Площадь', 'apt.areaV': '{n} м²', 'apt.floor': 'Этаж', 'apt.rooms': 'Комнат',
    'apt.price': 'Цена', 'apt.sold': 'Продана {when}', 'apt.soldNote': 'Заметка: {note}',
    'apt.current': 'Текущая бронь', 'apt.noCurrent': 'Сейчас брони нет', 'apt.bookings': 'Все брони', 'apt.viewings': 'Показы', 'apt.history': 'История',
    'apt.none': 'Пока ничего', 'apt.deposit': 'Депозит', 'apt.until': 'до {when}', 'apt.leftOf': 'осталось {left}', 'apt.overdue': 'срок вышел',
    'apt.tgLinked': 'Telegram привязан', 'apt.noTg': 'Telegram не привязан',
    'apt.reason': 'Причина: {text}', 'apt.cancelBy.client': 'отменил клиент', 'apt.cancelBy.developer': 'отменил застройщик',
    'apt.loadFail': 'Не удалось загрузить карточку',
    'vw.scheduled': 'Назначен', 'vw.done': 'Состоялся', 'vw.no_show': 'Не пришёл', 'vw.cancelled': 'Отменён',
    'ch.web': 'сайт', 'ch.telegram': 'Telegram', 'ch.mini': 'мини-приложение', 'ch.admin': 'админка', 'ch.mcp': 'MCP',
    'actor.client': 'клиент', 'actor.staff': 'сотрудник', 'actor.system': 'система', 'actor.job': 'таймер', 'actor.mcp': 'MCP', 'actor.agent': 'ИИ', 'actor.provider': 'платёжная система'
  },
  en: {
    'unit.sum': 'UZS', 'left.min': '{n} min', 'left.h': '{n} h', 'left.dh': '{d} d {h} h',
    'app.loading': 'Loading…', 'app.fail': 'Could not load. Retrying automatically',
    'login.title': 'Staff sign-in', 'login.login': 'Login', 'login.password': 'Password', 'login.submit': 'Sign in', 'login.busy': 'Signing in…',
    'nav.logout': 'Sign out', 'nav.theme': 'Theme', 'nav.units': 'Board', 'nav.inbox': 'With a manager', 'nav.notfound': 'Section not found',
    'role.manager': 'Manager', 'role.head': 'Head',
    'tg.warn': 'Link Telegram to take clients from the group',
    'st.free': 'Free', 'st.held': 'Being booked', 'st.booked': 'Booked', 'st.sold': 'Sold',
    'bk.held': 'Awaiting payment', 'bk.booked': 'Booked', 'bk.hold_expired': 'Hold expired', 'bk.released': 'Released by client',
    'bk.expired': 'Booking expired', 'bk.cancelled': 'Cancelled', 'bk.converted': 'Sold',
    'units.title': 'Board', 'units.status': 'Status', 'units.rooms': 'Rooms', 'units.floor': 'Floor', 'units.all': 'All',
    'units.studio': 'Studio', 'units.roomsN': '{n} rooms', 'units.soon': 'Expires within 24 h', 'units.reset': 'Reset',
    'units.floorN': 'fl. {n}', 'units.count': 'Showing {n} of {all}', 'units.legend': 'Refreshes every 5 s', 'units.empty': 'No apartments',
    'units.updated': 'Updated {time}', 'units.pick': 'Pick an apartment on the board', 'units.floorLabel': 'Floor {n}',
    'apt.title': 'Apartment {no}', 'apt.close': 'Close', 'apt.area': 'Area', 'apt.areaV': '{n} m²', 'apt.floor': 'Floor', 'apt.rooms': 'Rooms',
    'apt.price': 'Price', 'apt.sold': 'Sold {when}', 'apt.soldNote': 'Note: {note}',
    'apt.current': 'Current booking', 'apt.noCurrent': 'No booking right now', 'apt.bookings': 'All bookings', 'apt.viewings': 'Viewings', 'apt.history': 'History',
    'apt.none': 'Nothing yet', 'apt.deposit': 'Deposit', 'apt.until': 'until {when}', 'apt.leftOf': '{left} left', 'apt.overdue': 'overdue',
    'apt.tgLinked': 'Telegram linked', 'apt.noTg': 'Telegram not linked',
    'apt.reason': 'Reason: {text}', 'apt.cancelBy.client': 'cancelled by the client', 'apt.cancelBy.developer': 'cancelled by the developer',
    'apt.loadFail': 'Could not load the card',
    'vw.scheduled': 'Scheduled', 'vw.done': 'Done', 'vw.no_show': 'No-show', 'vw.cancelled': 'Cancelled',
    'ch.web': 'site', 'ch.telegram': 'Telegram', 'ch.mini': 'mini app', 'ch.admin': 'admin', 'ch.mcp': 'MCP',
    'actor.client': 'client', 'actor.staff': 'staff', 'actor.system': 'system', 'actor.job': 'timer', 'actor.mcp': 'MCP', 'actor.agent': 'AI', 'actor.provider': 'payment provider'
  },
  uz: {
    'unit.sum': 'so‘m', 'left.min': '{n} daq', 'left.h': '{n} soat', 'left.dh': '{d} kun {h} soat',
    'app.loading': 'Yuklanmoqda…', 'app.fail': 'Yuklab bo‘lmadi. O‘zi qayta uriniladi',
    'login.title': 'Xodimlar kirishi', 'login.login': 'Login', 'login.password': 'Parol', 'login.submit': 'Kirish', 'login.busy': 'Kirilmoqda…',
    'nav.logout': 'Chiqish', 'nav.theme': 'Mavzu', 'nav.units': 'Shaxmatka', 'nav.inbox': 'Menejer bilan', 'nav.notfound': 'Bo‘lim topilmadi',
    'role.manager': 'Menejer', 'role.head': 'Rahbar',
    'tg.warn': 'Guruhdan mijozlarni olish uchun Telegramni ulang',
    'st.free': 'Bo‘sh', 'st.held': 'Rasmiylashtirilmoqda', 'st.booked': 'Band qilingan', 'st.sold': 'Sotilgan',
    'bk.held': 'To‘lov kutilmoqda', 'bk.booked': 'Band qilingan', 'bk.hold_expired': 'Ushlab turish tugadi', 'bk.released': 'Mijoz bekor qildi',
    'bk.expired': 'Bron muddati tugadi', 'bk.cancelled': 'Bekor qilingan', 'bk.converted': 'Sotilgan',
    'units.title': 'Shaxmatka', 'units.status': 'Holat', 'units.rooms': 'Xonalar', 'units.floor': 'Qavat', 'units.all': 'Hammasi',
    'units.studio': 'Studiya', 'units.roomsN': '{n} xona', 'units.soon': '24 soatda tugaydi', 'units.reset': 'Tozalash',
    'units.floorN': '{n}-qavat', 'units.count': '{all} tadan {n} ta ko‘rsatilgan', 'units.legend': 'Har 5 soniyada yangilanadi', 'units.empty': 'Kvartiralar yo‘q',
    'units.updated': 'Yangilandi {time}', 'units.pick': 'Shaxmatkadan kvartirani tanlang', 'units.floorLabel': '{n}-qavat',
    'apt.title': '{no}-kvartira', 'apt.close': 'Yopish', 'apt.area': 'Maydon', 'apt.areaV': '{n} m²', 'apt.floor': 'Qavat', 'apt.rooms': 'Xonalar',
    'apt.price': 'Narx', 'apt.sold': 'Sotilgan {when}', 'apt.soldNote': 'Izoh: {note}',
    'apt.current': 'Joriy bron', 'apt.noCurrent': 'Hozir bron yo‘q', 'apt.bookings': 'Barcha bronlar', 'apt.viewings': 'Ko‘rishlar', 'apt.history': 'Tarix',
    'apt.none': 'Hozircha hech narsa', 'apt.deposit': 'Depozit', 'apt.until': '{when} gacha', 'apt.leftOf': '{left} qoldi', 'apt.overdue': 'muddat o‘tdi',
    'apt.tgLinked': 'Telegram ulangan', 'apt.noTg': 'Telegram ulanmagan',
    'apt.reason': 'Sabab: {text}', 'apt.cancelBy.client': 'mijoz bekor qildi', 'apt.cancelBy.developer': 'quruvchi bekor qildi',
    'apt.loadFail': 'Kartani yuklab bo‘lmadi',
    'vw.scheduled': 'Belgilangan', 'vw.done': 'Bo‘lib o‘tdi', 'vw.no_show': 'Kelmadi', 'vw.cancelled': 'Bekor qilindi',
    'ch.web': 'sayt', 'ch.telegram': 'Telegram', 'ch.mini': 'mini-ilova', 'ch.admin': 'admin', 'ch.mcp': 'MCP',
    'actor.client': 'mijoz', 'actor.staff': 'xodim', 'actor.system': 'tizim', 'actor.job': 'taymer', 'actor.mcp': 'MCP', 'actor.agent': 'AI', 'actor.provider': 'to‘lov tizimi'
  }
};

let lang = 'ru';
let saved = false;
try { const s = localStorage.getItem(KEY); if (LANGS.includes(s)) { lang = s; saved = true; } } catch { /* storage unavailable */ }
const listeners = new Set();

export const getLang = () => lang;
export const hasSavedLang = () => saved;
export const onLangChange = fn => listeners.add(fn);

// remember — the person chose it (kept in this browser); false when the language comes from the account.
export function setLang(next, remember = true) {
  if (!LANGS.includes(next)) return;
  if (remember) { saved = true; try { localStorage.setItem(KEY, next); } catch { /* storage unavailable */ } }
  if (next === lang) return;
  lang = next;
  document.documentElement.lang = next;
  listeners.forEach(fn => fn(next));
}

export function addTexts(more) {
  for (const l of LANGS) Object.assign(dict[l], more[l] || {});
}

export function t(key, vars = {}) {
  const s = dict[lang][key] ?? dict.ru[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
}
