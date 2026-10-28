// Texts of the furniture order page /o/… (11 §6.6, S) and the answer of the order form. Merged into `dict` by i18n.js;
// the payment method, the offer checkbox and the network texts come from bk.page.* (i18nBooking.js).
export const orderTexts = {
  ru: {
    'od.title': 'Заказ мебели №{no}', 'od.loading': 'Загружаем заказ…', 'od.content': 'Состав заказа', 'od.project': 'Проект «{name}»',
    'od.room': 'Комната', 'od.items': 'предметов: {n}', 'od.estimate': 'Оценка стоимости: {sum} сум',
    'od.prepay': 'Предоплата {pct}%: {sum} сум', 'od.prepayNote': 'Остаток оплачивается после доставки и сборки. Сроки и итоговую цену подтвердит менеджер.',
    'od.stage': 'Этап заказа', 'od.paid': 'Предоплата {sum} сум внесена {when}.', 'od.cancelled': 'Заказ отменён. Если предоплата была внесена, менеджер оформит её возврат.',
    'od.noPrepay': 'Для этого заказа предоплата не нужна — менеджер свяжется с вами.', 'od.apt': 'Квартира №{no}',
    'od.st.accepted': 'принят', 'od.st.production': 'производство', 'od.st.delivery': 'доставка', 'od.st.assembly': 'сборка', 'od.st.done': 'готово',
    'order.okPay': 'Заявка №{id} отправлена. Внести предоплату можно на странице заказа.', 'order.goPay': 'Перейти к оплате предоплаты'
  },
  uz: {
    'od.title': '№{no} mebel buyurtmasi', 'od.loading': 'Buyurtma yuklanmoqda…', 'od.content': 'Buyurtma tarkibi', 'od.project': '«{name}» loyihasi',
    'od.room': 'Xona', 'od.items': 'buyumlar: {n}', 'od.estimate': 'Taxminiy narx: {sum} so‘m',
    'od.prepay': '{pct}% oldindan to‘lov: {sum} so‘m', 'od.prepayNote': 'Qolgan qismi yetkazib berish va yig‘ishdan keyin to‘lanadi. Muddat va yakuniy narxni menejer tasdiqlaydi.',
    'od.stage': 'Buyurtma bosqichi', 'od.paid': '{sum} so‘m oldindan to‘lov {when} kiritildi.', 'od.cancelled': 'Buyurtma bekor qilindi. Oldindan to‘lov kiritilgan bo‘lsa, menejer uni qaytarib beradi.',
    'od.noPrepay': 'Bu buyurtma uchun oldindan to‘lov kerak emas — menejer siz bilan bog‘lanadi.', 'od.apt': '{no}-kvartira',
    'od.st.accepted': 'qabul qilindi', 'od.st.production': 'ishlab chiqarish', 'od.st.delivery': 'yetkazib berish', 'od.st.assembly': 'yig‘ish', 'od.st.done': 'tayyor',
    'order.okPay': '№{id} buyurtma yuborildi. Oldindan to‘lovni buyurtma sahifasida kiritish mumkin.', 'order.goPay': 'Oldindan to‘lovga o‘tish'
  },
  en: {
    'od.title': 'Furniture order No. {no}', 'od.loading': 'Loading the order…', 'od.content': 'What is ordered', 'od.project': 'Project “{name}”',
    'od.room': 'Room', 'od.items': 'items: {n}', 'od.estimate': 'Estimated cost: {sum} UZS',
    'od.prepay': 'Prepayment {pct}%: {sum} UZS', 'od.prepayNote': 'The rest is paid after delivery and assembly. A manager will confirm the dates and the final price.',
    'od.stage': 'Order stage', 'od.paid': 'The prepayment of {sum} UZS was made {when}.', 'od.cancelled': 'The order is cancelled. If the prepayment was made, a manager will arrange the refund.',
    'od.noPrepay': 'This order needs no prepayment — a manager will contact you.', 'od.apt': 'Apartment No. {no}',
    'od.st.accepted': 'accepted', 'od.st.production': 'production', 'od.st.delivery': 'delivery', 'od.st.assembly': 'assembly', 'od.st.done': 'done',
    'order.okPay': 'Order #{id} sent. You can make the prepayment on the order page.', 'order.goPay': 'Go to the prepayment'
  }
};
