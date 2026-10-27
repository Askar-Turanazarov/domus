// Shared by the bookings and payments screens (12 §4): texts of payments and refunds, status badges, the cursor list loader.
import { el } from '../ui.js';
import { t, addTexts } from '../i18n.js';

addTexts({
  ru: { 'form.required': 'Заполните поле: {field}', 'form.cancel': 'Отмена', 'list.more': 'Показать ещё', 'list.empty': 'Ничего не найдено',
    'pay.st.pending': 'Ждёт оплаты', 'pay.st.processing': 'В обработке', 'pay.st.succeeded': 'Оплачен', 'pay.st.failed': 'Не прошёл', 'pay.st.cancelled': 'Отменён',
    'pay.st.refund_due': 'К возврату', 'pay.st.refunded': 'Возвращён',
    'pay.prov.card': 'UzCard / HUMO', 'pay.prov.click': 'Click', 'pay.prov.stripe': 'Stripe',
    'pay.fail.bank_declined': 'Банк отклонил', 'pay.fail.insufficient_funds': 'Недостаточно средств', 'pay.fail.code_attempts_exceeded': 'Код введён неверно 3 раза',
    'pay.fail.session_expired': 'Время на подтверждение истекло', 'pay.fail.hold_expired': 'Удержание истекло', 'pay.fail.provider_error': 'Платёжная система не ответила',
    'pay.fail.cancelled_by_user': 'Отменил клиент', 'pay.fail.replaced': 'Заменён новой оплатой', 'pay.fail.booking_closed': 'Бронь закрыта', 'pay.fail.manual_required': 'Нужен ручной возврат в кабинете Click',
    'rf.st.pending': 'Возврат идёт', 'rf.st.succeeded': 'Возврат выполнен', 'rf.st.failed': 'Возврат не удался',
    'rf.reason.developer_cancel': 'Отмена застройщиком', 'rf.reason.late_payment': 'Оплата после срока', 'rf.reason.duplicate_payment': 'Повторная оплата', 'rf.reason.manual': 'Вручную' },
  en: { 'form.required': 'Fill in: {field}', 'form.cancel': 'Cancel', 'list.more': 'Show more', 'list.empty': 'Nothing found',
    'pay.st.pending': 'Awaiting payment', 'pay.st.processing': 'Processing', 'pay.st.succeeded': 'Paid', 'pay.st.failed': 'Failed', 'pay.st.cancelled': 'Cancelled',
    'pay.st.refund_due': 'To refund', 'pay.st.refunded': 'Refunded',
    'pay.prov.card': 'UzCard / HUMO', 'pay.prov.click': 'Click', 'pay.prov.stripe': 'Stripe',
    'pay.fail.bank_declined': 'Declined by the bank', 'pay.fail.insufficient_funds': 'Insufficient funds', 'pay.fail.code_attempts_exceeded': 'Wrong code 3 times',
    'pay.fail.session_expired': 'Confirmation time is up', 'pay.fail.hold_expired': 'Hold expired', 'pay.fail.provider_error': 'Payment system did not respond',
    'pay.fail.cancelled_by_user': 'Cancelled by the client', 'pay.fail.replaced': 'Replaced by a new payment', 'pay.fail.booking_closed': 'Booking closed', 'pay.fail.manual_required': 'Manual refund needed in the Click portal',
    'rf.st.pending': 'Refund in progress', 'rf.st.succeeded': 'Refund done', 'rf.st.failed': 'Refund failed',
    'rf.reason.developer_cancel': 'Cancelled by the developer', 'rf.reason.late_payment': 'Payment after the deadline', 'rf.reason.duplicate_payment': 'Duplicate payment', 'rf.reason.manual': 'Manual' },
  uz: { 'form.required': 'Maydonni to‘ldiring: {field}', 'form.cancel': 'Bekor qilish', 'list.more': 'Yana ko‘rsatish', 'list.empty': 'Hech narsa topilmadi',
    'pay.st.pending': 'To‘lov kutilmoqda', 'pay.st.processing': 'Jarayonda', 'pay.st.succeeded': 'To‘langan', 'pay.st.failed': 'O‘tmadi', 'pay.st.cancelled': 'Bekor qilingan',
    'pay.st.refund_due': 'Qaytarilishi kerak', 'pay.st.refunded': 'Qaytarilgan',
    'pay.prov.card': 'UzCard / HUMO', 'pay.prov.click': 'Click', 'pay.prov.stripe': 'Stripe',
    'pay.fail.bank_declined': 'Bank rad etdi', 'pay.fail.insufficient_funds': 'Mablag‘ yetarli emas', 'pay.fail.code_attempts_exceeded': 'Kod 3 marta noto‘g‘ri',
    'pay.fail.session_expired': 'Tasdiqlash vaqti tugadi', 'pay.fail.hold_expired': 'Ushlab turish tugadi', 'pay.fail.provider_error': 'To‘lov tizimi javob bermadi',
    'pay.fail.cancelled_by_user': 'Mijoz bekor qildi', 'pay.fail.replaced': 'Yangi to‘lov bilan almashtirildi', 'pay.fail.booking_closed': 'Bron yopilgan', 'pay.fail.manual_required': 'Click kabinetida qo‘lda qaytarish kerak',
    'rf.st.pending': 'Qaytarish davom etmoqda', 'rf.st.succeeded': 'Qaytarish bajarildi', 'rf.st.failed': 'Qaytarish bajarilmadi',
    'rf.reason.developer_cancel': 'Quruvchi bekor qildi', 'rf.reason.late_payment': 'Muddatdan keyingi to‘lov', 'rf.reason.duplicate_payment': 'Takroriy to‘lov', 'rf.reason.manual': 'Qo‘lda' }
});

// An unknown key shows as it is: a new status from the server does not break the screen.
export const label = (prefix, key) => { const s = t(prefix + key); return s === prefix + key ? String(key) : s; };

export const payBadge = status => el('span', { class: `adm2-badge pay-${status}` }, label('pay.st.', status));
export const refundBadge = status => el('span', { class: `adm2-badge rf-${status}` }, label('rf.st.', status));
// «HUMO 9860 •••• 0001», «Click», «Stripe»: the brand and the mask, never a number.
export const method = p => (p.cardBrand ? `${p.cardBrand}${p.cardMask ? ' ' + p.cardMask : ''}` : label('pay.prov.', p.provider));

// Messages of an API error for a dialog or a toast; on `stale` the screen reloads (the caller does it).
export const isStale = ex => ex?.code === 'stale';
