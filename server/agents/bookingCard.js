// The card of one booking in the «my bookings» reply: the complex, the booking number, the apartment (number, area, floor),
// a closing note by the status and a link to the personal booking page (shown as a button, not as a bare URL).
import { t } from '../i18n/index.js';
import { areaText, money, tashkent } from '../notify/format.js';

// b — an item of the my_bookings tool → { title, lines, note, url, label }
export function bookingCard(b, lang) {
  const lines = [t(lang, 'agent.bk.no', { no: b.bookingNo }), t(lang, 'agent.bk.apt', { no: b.apartmentNo })];
  if (b.area != null) lines.push(t(lang, 'agent.bk.area', { area: areaText(b.area, lang) }));
  if (b.floor != null) lines.push(t(lang, 'agent.bk.floor', { floor: b.floor }));
  const note = t(lang, `agent.bk.end.${b.status}`, { until: tashkent(b.until, lang), deposit: money(b.deposit) });
  return { title: t(lang, 'agent.bk.title'), lines, note, url: b.link, label: t(lang, b.status === 'held' ? 'tpl.btn.pay' : 'tpl.btn.my_booking') };
}
