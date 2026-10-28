// seed --demo (02 §8): a believable history of 30 days up to `now` — clients, 19 sales, 17 live bookings (3 burn «tomorrow»: now + 26…34 h; 2 in 6…20 h),
// burnt, cancelled and expired bookings, viewings, visitors, dialogs. Deterministic: the same `now` gives the same data (a seeded generator).
// The rows are written straight, with times from the plan, and the events go through the core's emit() with the time of each fact — the functions of
// the core would also leave jobs and Outbox messages for 30 days back (real Telegram sends to made-up people). The live bookings do get their expire and
// reminder jobs so that they really burn on time; the demo clients have no chat, so a reminder is skipped.
import crypto from 'node:crypto';
import { emit } from '../../core/events.js';
import { schedule } from '../../core/jobs.js';
import { readApartments, seedBase } from './base.js';

const H = 3600e3, MIN = 60e3, DAY = 24 * H, TASHKENT = 5 * H;
const KEEP = new Set(['schema_migrations', 'settings', 'apartments', 'staff', 'kb_documents', 'kb_chunks', 'ai_provider_state']);

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const NAMES = [
  ['Азиз Каримов', 'uz'], ['Дилноза Рахимова', 'uz'], ['Жасур Исмоилов', 'uz'], ['Малика Юсупова', 'uz'], ['Улугбек Тошматов', 'uz'], ['Нодира Абдуллаева', 'uz'],
  ['Бекзод Холматов', 'uz'], ['Шахноза Эргашева', 'uz'], ['Сардор Набиев', 'uz'], ['Мадина Саидова', 'uz'], ['Отабек Мирзаев', 'uz'], ['Феруза Каримова', 'uz'], ['Достон Хасанов', 'uz'],
  ['Анна Соколова', 'ru'], ['Игорь Петров', 'ru'], ['Елена Ким', 'ru'], ['Сергей Волков', 'ru'], ['Ольга Мартынова', 'ru'], ['Дмитрий Орлов', 'ru'], ['Наталья Ли', 'ru'],
  ['Алексей Попов', 'ru'], ['Виктория Фёдорова', 'ru'], ['Андрей Захаров', 'ru'], ['Марина Тен', 'ru'], ['Руслан Алиев', 'ru'], ['Светлана Гусева', 'ru'], ['Павел Новиков', 'ru'],
  ['Ирина Белова', 'ru'], ['Тимур Саттаров', 'ru'], ['Юлия Пак', 'ru'], ['Максим Романов', 'ru'], ['Камила Нурматова', 'ru'], ['Артём Козлов', 'ru'], ['Лола Азимова', 'uz'],
  ['Эльдор Рустамов', 'uz'], ['Гулноза Умарова', 'uz'], ['Фаррух Кадыров', 'uz'], ['Зарина Хамидова', 'ru'], ['Санжар Юлдашев', 'uz'], ['Мехрибон Назарова', 'uz'],
  ['James Carter', 'en'], ['Emily Brown', 'en'], ['Daniel Smith', 'en'], ['Нигора Салимова', 'uz'], ['Владислав Чой', 'ru']
];
const REASONS = ['bank_declined', 'insufficient_funds', 'code_attempts_exceeded', 'session_expired', 'bank_declined'];
const QUESTIONS = ['Какие квартиры свободны на высоких этажах?', 'Сколько стоит двушка?', 'Есть ли рассрочка?', 'Покажите студии', 'Можно ли посмотреть квартиру в выходные?',
  'Какой первый взнос?', 'Когда сдача дома?', 'Есть ли паркинг?', 'Сравните две квартиры', 'Хочу забронировать'];
const ANSWERS = ['Подобрала несколько вариантов, посмотрите на шахматке.', 'Рассрочка до 4 лет, первый взнос от 30%.', 'Могу записать вас на показ.', 'Уточню у менеджера и вернусь с ответом.'];

export async function seedDemo(db, { now = new Date(), seed = 20261102 } = {}) {
  const rnd = rng(seed ^ Math.floor(now.getTime() / DAY));
  const pick = a => a[Math.floor(rnd() * a.length)];
  const between = (a, b) => a + rnd() * (b - a);
  const int = (a, b) => Math.floor(between(a, b + 1));
  const uuid = () => { const b = Buffer.from(Array.from({ length: 16 }, () => Math.floor(rnd() * 256))); b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80; const h = b.toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
  const t0 = now.getTime();
  const dayStart = off => Math.floor((t0 + TASHKENT) / DAY) * DAY - TASHKENT - off * DAY;       // 00:00 Tashkent of that day
  const ymd = off => new Date(dayStart(off) + TASHKENT + 12 * H).toISOString().slice(0, 10);
  // A moment on day `off` days ago, hours 9…21; never in the future.
  const moment = (off, from = 9, to = 21) => new Date(Math.min(dayStart(off) + between(from, to) * H, t0 - between(4, 90) * MIN));
  const dayWeight = off => { const wd = new Date(dayStart(off) + TASHKENT + 12 * H).getUTCDay(); return 1 + (wd === 0 || wd === 6 ? 0.8 : 0) + 0.6 * (1 - off / 30); };
  const weights = Array.from({ length: 30 }, (_, i) => dayWeight(i));
  const pickDay = () => { let x = rnd() * weights.reduce((a, b) => a + b, 0); for (let i = 0; i < 30; i++) { x -= weights[i]; if (x <= 0) return i; } return 29; };
  const iso = d => new Date(d).toISOString();

  const apartments = readApartments();
  const soldApts = apartments.filter(a => a.status === 'sold'), bookedApts = apartments.filter(a => a.status === 'booked'), freeApts = apartments.filter(a => a.status === 'free');
  const staff = await db.one("SELECT id FROM staff WHERE role = 'head' AND active ORDER BY created_at LIMIT 1");
  const staffActor = staff ? { type: 'staff', id: staff.id, role: 'head', channel: 'admin' } : { type: 'system' };
  const SYS = { type: 'system' };

  // ---- clients ------------------------------------------------------------------------------------------------------------------------
  const clients = NAMES.map(([name, lang], i) => {
    const l = rnd();
    return { id: uuid(), name, phone: `+99890000${String(i + 1).padStart(4, '0')}`, lang: lang === 'en' ? 'en' : l < 0.05 && lang === 'ru' ? 'uz' : lang,
      tg: i % 2 === 0 ? 9_000_000_001 + i : null, createdAt: moment(Math.min(29, int(1, 29)), 9, 21), channel: pick(['web', 'web', 'telegram', 'mini']) };
  });
  const order = clients.map((_, i) => i).sort(() => rnd() - 0.5);
  let cursor = 0;
  const nextClient = () => order[cursor++ % order.length];

  // ---- bookings ------------------------------------------------------------------------------------------------------------------------
  const bookings = [];
  const events = [];
  const ev = (at, type, refs, data = {}, actor = SYS) => events.push({ at: new Date(at), type, refs, data, actor });
  const providers = ['card', 'card', 'card', 'card', 'card', 'card', 'card', 'card', 'card', 'click', 'click', 'click', 'click', 'stripe', 'stripe', 'stripe', 'stripe'];
  const channelOf = () => pick(['web', 'web', 'web', 'telegram', 'telegram', 'mini']);
  const add = o => { const b = { id: uuid(), clientIdx: nextClient(), channel: channelOf(), deposit: 10_000_000, provider: pick(['card', 'card', 'click', 'stripe']), ...o }; b.apt = apartments.find(a => a.no === b.apartmentNo); bookings.push(b); return b; };

  // 19 sales: sold_at evenly over 30 days, a converted booking and a deposit each.
  soldApts.forEach((a, i) => {
    const off = 1 + Math.floor((i * 29) / soldApts.length);
    const soldAt = moment(off, 10, 18).getTime();
    const paidAt = Math.max(dayStart(29) + H, soldAt - between(1, 6) * DAY), heldAt = paidAt - between(5, 14) * MIN;
    add({ apartmentNo: a.no, status: 'converted', heldAt, paidAt, soldAt, expiresAt: paidAt + 72 * H, closedAt: soldAt });
  });
  // 17 live bookings: paid; deadlines 3 × (now + 26…34 h), 2 × (6…20 h), the rest 40…70 h; two were extended.
  const left = [...Array.from({ length: 3 }, () => between(26, 34)), ...Array.from({ length: 2 }, () => between(6, 20)),
    ...Array.from({ length: bookedApts.length - 5 }, () => between(40, 70))];
  bookedApts.forEach((a, i) => {
    const extended = i === 5 || i === 9 ? 1 : 0;
    const expiresAt = t0 + left[i] * H, paidAt = expiresAt - 72 * H - extended * 24 * H;
    const b = add({ apartmentNo: a.no, status: 'booked', paidAt: i === 10 ? t0 - between(40, 80) * MIN : paidAt, heldAt: 0, expiresAt, extended, provider: providers[i], live: true });
    b.heldAt = b.paidAt - between(5, 14) * MIN;
    if (i === 10) b.expiresAt = b.paidAt + 72 * H;          // paid within the last hour: «today» has a payment even when the day has just begun
  });
  // 6 burnt bookings (one deposit returned by hand), 3 cancelled, 12 expired holds.
  for (let i = 0; i < 6; i++) {
    const paidAt = moment(int(4, 29), 9, 20).getTime();
    add({ apartmentNo: pick(freeApts).no, status: 'expired', paidAt, heldAt: paidAt - between(5, 14) * MIN, expiresAt: paidAt + 72 * H, closedAt: paidAt + 72 * H, refundByHand: i === 0 });
  }
  for (let i = 0; i < 3; i++) {
    const paidAt = moment(int(1, 29), 9, 20).getTime();
    add({ apartmentNo: pick(freeApts).no, status: 'cancelled', paidAt, heldAt: paidAt - between(5, 14) * MIN, expiresAt: paidAt + 72 * H, closedAt: Math.min(paidAt + between(2, 30) * H, t0 - H),
      initiator: i === 2 ? 'developer' : 'client', reason: i === 2 ? 'Квартира снята с продажи' : 'Клиент передумал' });
  }
  for (let i = 0; i < 12; i++) {
    const heldAt = i < 2 ? t0 - between(30, 110) * MIN : Math.min(moment(pickDay(), 9, 21).getTime(), t0 - 20 * MIN);
    add({ apartmentNo: pick(freeApts).no, status: 'hold_expired', heldAt, paidAt: null, expiresAt: heldAt + 15 * MIN, closedAt: heldAt + 15 * MIN, failed: i < 5 ? REASONS[i] : null });
  }
  bookings.sort((x, y) => x.heldAt - y.heldAt);

  for (const [i, c] of clients.entries()) {            // a client exists before the first hold
    const mine = bookings.filter(b => b.clientIdx === i).map(b => b.heldAt - 30 * MIN);
    if (mine.length) c.createdAt = new Date(Math.min(c.createdAt.getTime(), ...mine));
  }

  // ---- write ----------------------------------------------------------------------------------------------------------------------------
  await seedBase(db, { now });
  return db.tx(async q => {
    await q.query('UPDATE apartments SET sold_at = NULL, sold_booking_id = NULL, sold_by = NULL, sold_note = NULL');
    await wipe(q);
    for (const c of clients) {
      await q.query(`INSERT INTO clients (id, name, phone, phone_verified, telegram_user_id, lang, channels, first_channel, created_at, updated_at, last_seen_at)
        VALUES ($1, $2, $3, $4, $5, $6, ARRAY[$7], $7, $8, $8, $8)`, [c.id, c.name, c.phone, c.tg != null, c.tg, c.lang, c.channel, c.createdAt]);
    }
    const codes = new Set();
    for (const b of bookings) {
      const c = clients[b.clientIdx];
      const holdUntil = b.heldAt + 15 * MIN;
      await q.query(`INSERT INTO bookings (id, apartment_no, client_id, status, channel, created_by, expires_at, held_at, booked_at, closed_at, deposit_amount, price_at_booking,
          consent_version, consent_at, cancel_initiator, cancel_reason, extended_count, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $8, $14, $15, $16, $17)`,
      [b.id, b.apartmentNo, c.id, b.status, b.channel, JSON.stringify({ type: 'client', id: c.id, role: 'client', channel: b.channel }), new Date(b.expiresAt), new Date(b.heldAt),
        b.paidAt ? new Date(b.paidAt) : null, b.closedAt ? new Date(b.closedAt) : null, b.deposit, b.apt.price, '2026-10-27', b.initiator ?? null, b.reason ?? null, b.extended ?? 0,
        new Date(b.closedAt ?? b.paidAt ?? b.heldAt)]);
      const refs = { bookingId: b.id, apartmentNo: b.apartmentNo, clientId: c.id };
      ev(b.heldAt, 'booking.held', refs, { channel: b.channel, expiresAt: iso(holdUntil), deposit: b.deposit }, { type: 'client', id: c.id, role: 'client', channel: b.channel });
      let code;
      do { code = `P-${crypto.createHash('sha1').update(String(rnd())).digest('hex').slice(0, 8).toUpperCase()}`; } while (codes.has(code));
      codes.add(code);
      const pay = { id: uuid(), code };
      const card = b.provider === 'card' ? [pick(['HUMO', 'UZCARD']), `${pick(['9860', '8600'])} •••• ${String(int(1, 9999)).padStart(4, '0')}`] : [null, null];
      const insertPay = (status, at, extra = {}) => q.query(`INSERT INTO payments (id, code, kind, booking_id, client_id, provider, amount, status, failure_reason, provider_ref, card_brand, card_mask,
          succeeded_at, created_by, created_at, updated_at) VALUES ($1, $2, 'deposit', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)`,
      [pay.id, code, b.id, c.id, b.provider, b.deposit, status, extra.failure ?? null, `seed-${code}`, card[0], card[1], extra.succeededAt ?? null, JSON.stringify({ type: 'client', id: c.id, role: 'client', channel: b.channel }), new Date(at)]);
      if (b.paidAt) {
        const refunded = b.refundByHand || b.initiator === 'developer';
        await insertPay(refunded ? 'refunded' : 'succeeded', b.paidAt, { succeededAt: new Date(b.paidAt) });
        ev(b.paidAt, 'booking.paid', { ...refs, paymentId: pay.id }, { amount: b.deposit, provider: b.provider, paymentCode: code, expiresAt: iso(b.expiresAt) });
        if (refunded) {
          const at = b.closedAt + (b.refundByHand ? 3 * H : 20 * MIN);
          const done = Math.min(at, t0 - 10 * MIN);
          await q.query(`INSERT INTO refunds (payment_id, amount, reason, status, provider_ref, requested_by, created_at, updated_at, completed_at)
            VALUES ($1, $2, $3, 'succeeded', $4, $5, $6, $6, $6)`, [pay.id, b.deposit, b.refundByHand ? 'manual' : 'developer_cancel', `seed-refund-${code}`, JSON.stringify(staffActor), new Date(done)]);
          ev(done, 'refund.succeeded', { ...refs, paymentId: pay.id }, { reason: b.refundByHand ? 'manual' : 'developer_cancel', amount: b.deposit, provider: b.provider });
        }
        if (b.extended) ev(Math.min(t0 - 30 * MIN, b.paidAt + 40 * H), 'booking.extended', refs, { from: iso(b.expiresAt - 24 * H), to: iso(b.expiresAt), reason: 'Клиент просил больше времени', hours: 24 }, staffActor);
        if (b.status === 'expired') ev(b.expiresAt, 'booking.expired', refs, { expiresAt: iso(b.expiresAt) });
        if (b.status === 'cancelled') ev(b.closedAt, 'booking.cancelled', refs, { initiator: b.initiator, reason: b.reason, depositFate: b.initiator === 'developer' ? 'refund' : 'none' }, b.initiator === 'developer' ? staffActor : { type: 'client', id: c.id, role: 'client', channel: b.channel });
        if (b.live) {
          const exp = iso(b.expiresAt);
          await schedule(q, 'booking.expire', b.expiresAt, { bookingId: b.id, expectedExpiresAt: exp }, `booking.expire:${b.id}:${exp}`, { now: () => now });
          for (const h of [24, 3]) if (b.expiresAt - h * H - t0 > 30e3) {
            await schedule(q, 'booking.remind', b.expiresAt - h * H, { bookingId: b.id, expectedExpiresAt: exp, hoursBefore: h }, `booking.remind:${b.id}:${exp}:${h}`, { now: () => now });
          }
        }
        if (b.soldAt) {
          await q.query('UPDATE apartments SET sold_at = $2, sold_booking_id = $3, sold_by = $4, updated_at = $2, version = version + 1 WHERE no = $1',
            [b.apartmentNo, new Date(b.soldAt), b.id, JSON.stringify(staffActor)]);
          ev(b.soldAt, 'apartment.sold', refs, { price: b.apt.price, viaBooking: true }, staffActor);
        }
      } else if (b.failed) {
        await insertPay('failed', b.heldAt + 3 * MIN, { failure: b.failed });
        ev(b.heldAt + 3 * MIN, 'payment.failed', { ...refs, paymentId: pay.id }, { provider: b.provider, reason: b.failed });
        ev(b.closedAt, 'booking.hold_expired', refs, { expiresAt: iso(b.expiresAt) });
      } else {
        ev(b.closedAt, 'booking.hold_expired', refs, { expiresAt: iso(b.expiresAt) });
      }
    }
    await visitors(q);
    await viewings(q);
    await dialogs(q);
    events.sort((x, y) => x.at - y.at);
    for (const e of events) await emit(q, e.type, e.refs, e.data, e.actor, { now: () => e.at });
    return summary(q);
  });

  // ---- the rest ---------------------------------------------------------------------------------------------------------------------
  async function visitors(q) {
    const rows = [];
    for (let off = 0; off < 30; off++) {
      const n = Math.round(between(40, 100) * dayWeight(off) * (off === 0 ? 0.6 : 1));
      for (let i = 0; i < n; i++) rows.push([ymd(off), crypto.createHash('sha256').update(`${seed}:${off}:${i}`).digest('hex').slice(0, 32), rnd() < 0.15 ? 'mini' : 'web', new Date(dayStart(off) + between(8, 22) * H)]);
    }
    for (let i = 0; i < rows.length; i += 500) {
      const part = rows.slice(i, i + 500);
      await q.query(`INSERT INTO analytics_visits (day, visitor_hash, channel, first_at) VALUES ${part.map((_, k) => `($${k * 4 + 1}, $${k * 4 + 2}, $${k * 4 + 3}, $${k * 4 + 4})`).join(', ')} ON CONFLICT DO NOTHING`,
        part.flat().map(v => (v instanceof Date && v.getTime() > t0 ? new Date(t0 - MIN) : v)));
    }
  }

  async function viewings(q) {
    const slots = new Set();
    const make = async (past, i) => {
      const c = clients[int(0, clients.length - 1)], a = pick(apartments).no;
      const day = past ? 1 + int(0, 19) : -int(0, 4), hour = int(10, 18);
      let at = new Date(dayStart(day) + hour * H);
      if (past ? at.getTime() > t0 - H : at.getTime() < t0 + H) at = new Date(past ? t0 - (2 + i) * H : t0 + (3 + i) * H);
      const key = `${a}:${at.getTime()}`;
      if (slots.has(key)) return;
      slots.add(key);
      const created = new Date(Math.min(at.getTime() - between(20, 70) * H, t0 - 20 * MIN));
      const status = past ? (rnd() < 0.75 ? 'done' : 'no_show') : 'scheduled';
      const v = await q.one(`INSERT INTO viewings (apartment_no, client_id, at, name, phone, status, channel, created_by, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING id`, [a, c.id, at, c.name, c.phone, status, pick(['web', 'telegram']), JSON.stringify({ type: 'client', id: c.id, role: 'client', channel: 'web' }), created]);
      ev(created, 'viewing.created', { viewingId: v.id, apartmentNo: a, clientId: c.id }, { at: at.toISOString(), channel: 'web' }, { type: 'client', id: c.id, role: 'client', channel: 'web' });
    };
    for (let i = 0; i < 8; i++) await make(true, i);
    for (let i = 0; i < 10; i++) await make(false, i);
  }

  async function dialogs(q) {
    const full = new Set(order.slice(0, 6));
    const runs = [];
    const talk = async (clientIdx, startAt, messages, human) => {
      const c = clients[clientIdx], conv = uuid();
      const stamp = i => new Date(Math.min(startAt.getTime() + i * 40e3, t0 - MIN));
      await q.query(`INSERT INTO conversations (id, kind, client_id, channel, lang, mode, message_count, created_at, updated_at, last_message_at)
        VALUES ($1, 'client', $2, $3, $4, $5, $6, $7, $8, $8)`, [conv, c.id, pick(['web', 'telegram', 'mini']), c.lang, human ? 'human' : 'ai', messages, startAt, stamp(messages)]);
      for (let i = 0; i < messages; i++) {
        const user = i % 2 === 0, turn = user ? null : uuid();
        const fb = !user && rnd() < 0.12 ? (rnd() < 0.85 ? 1 : -1) : null;
        await q.query(`INSERT INTO messages (conversation_id, role, text, turn_id, feedback, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
          [conv, user ? 'user' : 'assistant', user ? pick(QUESTIONS) : pick(ANSWERS), turn, fb, stamp(i)]);
        if (turn) runs.push({ turn, conv, at: stamp(i) });
      }
      if (human) ev(stamp(messages), 'client.handoff_requested', { clientId: c.id }, { conversationId: conv, reason: 'other' }, { type: 'client', id: c.id, role: 'client', channel: 'web' });
    };
    // a dialog shortly before each hold of about two bookings out of three
    for (const b of bookings) if (rnd() < 0.65 || b.live) await talk(b.clientIdx, new Date(b.heldAt - between(4, 120) * MIN), full.has(b.clientIdx) ? 8 : int(2, 4), rnd() < 0.08);
    for (let i = 0; i < 30; i++) await talk(int(0, clients.length - 1), moment(pickDay(), 9, 22), int(1, 3), rnd() < 0.1);
    for (const idx of full) {
      await q.query(`UPDATE clients SET lead_score = $2, lead_summary = $3, lead_next_step = $4, lead_scored_at = $5 WHERE id = $1`,
        [clients[idx].id, pick(['hot', 'warm']), 'Ищет квартиру 2–3 комнаты, интересуется рассрочкой.', 'Предложить показ в выходные', new Date(t0 - 2 * H)]);
    }
    for (const r of runs) {
      const bad = rnd() < 0.04, fb = rnd() < 0.05;
      await q.query(`INSERT INTO agent_runs (turn_id, conversation_id, agent, role, provider, model, fallback, steps, tools, input_tokens, output_tokens, cost_usd, ms, ok, error, created_at)
        VALUES ($1, $2, 'sales', 'tools', 'gemini', $3, $4, $5, $6, $7, $8, 0, $9, $10, $11, $12)`,
      [r.turn, r.conv, fb ? 'gemini-3.6-flash' : 'gemini-3.8-flash', fb, int(1, 3), ['search_apartments'], int(900, 3000), int(80, 300), int(800, 4000), !bad, bad ? 'max_steps' : null, r.at]);
      if (rnd() < 0.7) await q.query(`INSERT INTO tool_calls (at, source, tool, role, turn_id, conversation_id, args, ok, ms) VALUES ($1, 'agent', $2, 'client', $3, $4, '{}', true, $5)`,
        [r.at, pick(['search_apartments', 'get_apartment', 'calc_installment', 'search_kb']), r.turn, r.conv, int(5, 120)]);
    }
    for (let i = 0; i < 6; i++) await q.query(`INSERT INTO kb_queries (at, query, mode, answered) VALUES ($1, $2, 'hybrid', false)`, [moment(pickDay(), 9, 21), pick(QUESTIONS)]);
  }

  // Every table of the business is emptied, children first (the foreign keys decide the order); the sequences start again.
  async function wipe(q) {
    const tables = (await q.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).map(r => r.tablename).filter(n => !KEEP.has(n));
    const deps = await q.query(`SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent FROM pg_constraint WHERE contype = 'f'`);
    const left = new Set(tables), order = [];
    while (left.size) {
      const free = [...left].filter(t => !deps.some(d => d.parent === t && d.child !== t && left.has(d.child)));
      if (!free.length) throw new Error('cannot order tables: ' + [...left].join(', '));
      for (const t of free) { order.push(t); left.delete(t); }
    }
    for (const t of order) await q.query(`DELETE FROM ${t}`);
    const mine = new Set([...order.map(t => `${t}_id_seq`), 'booking_no_seq', 'order_no_seq', 'click_prepare_seq']);   // not the knowledge base's
    const seqs = await q.query(`SELECT c.relname AS name FROM pg_class c WHERE c.relkind = 'S' AND c.relnamespace = 'public'::regnamespace`);
    for (const s of seqs.filter(x => mine.has(x.name))) await q.query(`ALTER SEQUENCE ${s.name} RESTART`);
  }

  async function summary(q) {
    return q.one(`SELECT (SELECT count(*)::int FROM clients) AS clients, (SELECT count(*)::int FROM bookings) AS bookings,
      (SELECT count(*)::int FROM bookings WHERE status = 'booked') AS booked, (SELECT count(*)::int FROM apartments WHERE sold_at IS NOT NULL) AS sold,
      (SELECT count(*)::int FROM payments) AS payments, (SELECT count(*)::int FROM viewings) AS viewings, (SELECT count(*)::int FROM analytics_visits) AS visits,
      (SELECT count(*)::int FROM conversations) AS conversations, (SELECT count(*)::int FROM events) AS events`);
  }
}
