// «Demo: move the deadline» (03 §10, 12 §7, FR-DEMO-01, D-14): the head moves ONE booking's deadline to «in a minute» (or to just
// before a reminder) so the expiry can be shown live. Nothing else changes. Shared by the booking card and the apartment card.
import { api, newKey } from '../api.js';
import { el, toast, clock, askForm } from '../ui.js';
import { t, addTexts } from '../i18n.js';

addTexts({
  ru: { 'shf.title': 'Демо: сдвинуть срок', 'shf.hold_1m': 'Удержание: через 1 мин', 'shf.booking_1m': 'Бронь: через 1 мин', 'shf.booking_3h1m': 'Бронь: за 3 ч + 1 мин',
    'shf.booking_24h1m': 'Бронь: за 24 ч + 1 мин', 'shf.confirm': 'Это демо-действие: срок брони №{no} станет {time}. Остальные данные не меняются.', 'shf.do': 'Сдвинуть',
    'shf.done': 'Срок сдвинут', 'shf.stale': 'Бронь изменилась, обновили карточку' },
  en: { 'shf.title': 'Demo: move the deadline', 'shf.hold_1m': 'Hold: in 1 min', 'shf.booking_1m': 'Booking: in 1 min', 'shf.booking_3h1m': 'Booking: 3 h + 1 min before the end',
    'shf.booking_24h1m': 'Booking: 24 h + 1 min before the end', 'shf.confirm': 'This is a demo action: the deadline of booking {no} becomes {time}. Nothing else changes.', 'shf.do': 'Move',
    'shf.done': 'Deadline moved', 'shf.stale': 'The booking changed, the card is refreshed' },
  uz: { 'shf.title': 'Demo: muddatni siljitish', 'shf.hold_1m': 'Ushlab turish: 1 daqiqadan keyin', 'shf.booking_1m': 'Bron: 1 daqiqadan keyin', 'shf.booking_3h1m': 'Bron: tugashiga 3 soat + 1 daqiqa',
    'shf.booking_24h1m': 'Bron: tugashiga 24 soat + 1 daqiqa', 'shf.confirm': 'Bu demo harakat: {no}-bron muddati {time} bo‘ladi. Boshqa ma’lumotlar o‘zgarmaydi.', 'shf.do': 'Siljitish',
    'shf.done': 'Muddat siljitildi', 'shf.stale': 'Bron o‘zgardi, karta yangilandi' }
});

const MINUTE = 60e3, HOUR = 3600e3;
const TARGETS = {
  held: [['hold_1m', MINUTE]],
  booked: [['booking_1m', MINUTE], ['booking_3h1m', 3 * HOUR + MINUTE], ['booking_24h1m', 24 * HOUR + MINUTE]]
};

// The block for the head only; null for a closed booking. booking — { no, status, version }; onDone() reloads the screen.
export function shiftBlock(booking, onDone) {
  const targets = TARGETS[booking.status];
  if (!targets) return null;
  const ask = (target, ms) => {
    const key = newKey();
    return askForm({
      title: t('shf.title'), lead: t('shf.confirm', { no: booking.no, time: clock(Date.now() + ms) }), submit: t('shf.do'),
      run: async () => {
        try {
          await api(`/api/admin/bookings/${booking.no}/shift`, { method: 'POST', key, body: { target, expectedVersion: booking.version } });
        } catch (ex) {
          if (ex.code === 'stale' || ex.code === 'booking_not_active' || ex.code === 'booking_closed') { toast(t('shf.stale'), true); await onDone(); return 'stale'; }
          throw ex;
        }
        toast(t('shf.done'));
        await onDone();
      }
    });
  };
  return el('section', { class: 'adm2-sec adm2-demo', dataset: { block: 'shift' } }, el('h3', {}, t('shf.title')),
    el('div', { class: 'adm2-actions' }, targets.map(([target, ms]) =>
      el('button', { type: 'button', class: 'btn sm', dataset: { act: 'shift', target }, on: { click: () => ask(target, ms) } }, t('shf.' + target)))));
}
