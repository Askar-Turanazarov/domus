// Notification templates (04 §4): id, audience, the variables the core passes, the buttons. The texts live in
// server/i18n/{ru,uz,en}.json under tpl.<id>.text (and tpl.<id>.text.<variant>); the button captions under tpl.btn.<key>.
// Pure data: notify/render.js turns a template and its variables into a message.
//
// Button kinds: web — a mini-app (web_app) button in a private chat, a plain link in the group (web_app needs https);
// url — a link; cb — callback_data (≤ 64 bytes). A button whose address is missing, or not https, is left out.

const web = (key, path) => ({ key, kind: 'web', path });
const site = (key) => web(key, (v, lang) => v.apt != null ? `/${lang}#apt=${v.apt}` : `/${lang}`);
const planner = (key) => ({ key, kind: 'web', path: (v, lang) => `/${lang}/planner/` });
const my = (key = 'my_booking') => web(key, v => v.link);
const manager = { key: 'manager', kind: 'cb', data: () => 'mgr' };
const take = { key: 'take', kind: 'cb', data: v => v.clientId ? `take:${v.clientId}` : null };
const dialog = { key: 'dialog', kind: 'url', path: v => `/admin/clients/${v.clientId}` };
const admin = { key: 'admin', kind: 'url',
  path: v => v.clientId ? `/admin/clients/${v.clientId}` : v.bookingNo ? `/admin/bookings/${v.bookingNo}` : '/admin' };
const map = { key: 'map', kind: 'url', path: v => v.mapUrl, absolute: true };

// vars — what the core puts into the row (the test builds a sample from it); variant(v) → the suffix of the text key | null.
const client = (vars, buttons = [], extra = {}) => ({ audience: 'client', vars, buttons, ...extra });
const staff = (vars, buttons = [], extra = {}) => ({ audience: 'staff_group', vars, buttons, ...extra });

export const TEMPLATES = {
  // ── to the client (04 §4.1)
  hold_created: client(['apt', 'min', 'deposit', 'holdUntil', 'link'], [web('pay', v => v.link)]),
  payment_failed: client(['reason', 'apt', 'holdUntil', 'link'], [web('retry', v => v.link)]),
  hold_expired: client(['apt'], [site('open_apt')]),
  hold_cancelled: client(['apt', 'reason']),
  booking_confirmed: client(['apt', 'until', 'bookingNo', 'deposit', 'link'], [my(), site('open_3d')]),
  // the caption of the confirmation PDF (op send_document, 05 §10.4): the file itself is built at delivery
  booking_pdf: client(['bookingNo']),
  booking_reminder: client(['apt', 'until', 'hours', 'link'], [my(), manager]),
  booking_extended: client(['apt', 'until', 'link'], [my()]),
  booking_cancelled: client(['apt', 'reason', 'initiator', 'deposit'], [], { variant: v => v.initiator === 'developer' ? 'developer' : 'client' }),
  booking_expired: client(['apt'], [manager]),
  staff_reply: client(['text', 'staffName']),
  ai_returned: client([]),
  apartment_sold: client(['apt'], [planner('furnish')]),
  payment_late: client(['apt', 'amount']),
  refund_done: client(['amount', 'bookingNo'], [], { variant: v => v.bookingNo ? null : 'nobooking' }),
  viewing_confirmed: client(['apt', 'at', 'address', 'mapUrl'], [map]),
  viewing_reminder: client(['apt', 'time']),
  link_telegram_done: client(['bookingNo', 'link'], [my()]),
  order_prepaid: client(['amount', 'orderNo', 'link'], [my('my_order')]),
  order_stage_changed: client(['orderNo', 'stage', 'link'], [my('my_order')]),

  // ── to the staff group (04 §4.2)
  staff_booking_paid: staff(['bookingNo', 'apt', 'rooms', 'area', 'price', 'name', 'phoneMasked', 'channel', 'deposit', 'provider', 'until',
    'context', 'clientId'], [take, admin]),
  staff_booking_expiring: staff(['bookingNo', 'apt', 'until', 'staffName'], [admin]),
  staff_booking_extended: staff(['bookingNo', 'until', 'staffName', 'reason']),
  staff_booking_cancelled: staff(['bookingNo', 'initiator', 'reason', 'fate']),
  staff_booking_expired: staff(['bookingNo', 'apt', 'name', 'phoneMasked'], [admin]),
  staff_apartment_sold: staff(['apt', 'staffName']),
  staff_apartment_unsold: staff(['apt', 'staffName', 'reason']),
  staff_refund_done: staff(['amount', 'bookingNo', 'reason'], [], { variant: v => v.bookingNo ? null : 'nobooking' }),
  staff_viewing_created: staff(['apt', 'at', 'name', 'phoneMasked', 'clientId'], [take, admin]),
  staff_order_prepaid: staff(['amount', 'orderNo', 'apt', 'clientId'], [admin]),
  staff_new_request: staff(['apt', 'name', 'phoneMasked', 'comment', 'clientId'], [take, admin]),
  staff_extend_requested: staff(['bookingNo', 'apt', 'until', 'hoursText'], [admin]),
  staff_handoff: staff(['name', 'phoneMasked', 'context', 'clientId'], [take, admin]),
  staff_client_message: staff(['name', 'preview', 'clientId'], [dialog]),
  // «Беру клиента»: the original message edited — vars carry `of` (its template) and its own vars, plus staffName.
  staff_lead_taken: staff(['of', 'staffName'], [], { composed: true })
};

export const templateIds = Object.keys(TEMPLATES);
