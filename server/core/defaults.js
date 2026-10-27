// Business settings by default (02 §3.1, PRD §8). The head changes them in the admin (settings table);
// a change applies to new holds and bookings only — existing ones keep their snapshot.
export const DEFAULT_SETTINGS = Object.freeze({
  deposit_amount: 10_000_000,
  hold_minutes: 15,
  booking_hours: 72,
  max_active_bookings: 2,
  installment: { minDownPct: 30, terms: [{ months: 12, markupPct: 0 }, { months: 24, markupPct: 5 }, { months: 36, markupPct: 10 }] },
  furniture_prepay_pct: 30,
  reminders: { bookingHoursBefore: [24, 3], viewingHoursBefore: 3 },
  extend_max_hours: 168,
  chat_limits: { perMinute: 10, perDay: 200, perConversation: 40 },
  offer_version: '2026-10-27',
  ai: { geminiDisabled: false, primaryDisabled: false, geminiTier: 'free' },
  // Fictional, for the diploma only — marked «учебные» everywhere they are shown.
  bank_requisites: {
    name: 'ООО «Chinor Development» (учебные реквизиты)',
    inn: '000000000',
    account: '20208000000000000001',
    bank: 'Учебный банк (не существует)',
    mfo: '00000',
    address: 'г. Ташкент (вымышленный адрес)',
    phone: '+998 90 000 00 00'
  }
});
