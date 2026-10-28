// Numbers for the head and the dashboard (01 §3.2, 12 §9): the period is in Tashkent days. summary feeds the MCP tool sales_summary (D3-14);
// dashboardSummary / dashboardCharts / dashboardFeed feed the dashboard (D4-08, D-26: a manager gets counts, no money).
import { now as clockNow } from './clock.js';
import { DomainError, need } from './errors.js';
import { feed as eventsFeed } from './events.js';
import { aiCosts } from './adminAi.js';
import { aiState } from './adminSystem.js';
import { t } from '../i18n/index.js';

const TZ_MS = 5 * 3600e3;
const DAY_MS = 24 * 3600e3;

// 'YYYY-MM-DD' (a Tashkent day) → the Date of its 00:00.
const dayStart = s => new Date(Date.parse(`${s}T00:00:00Z`) - TZ_MS);
export const tashkentDay = d => new Date(d.getTime() + TZ_MS).toISOString().slice(0, 10);

// { from?, to? } as Tashkent days, `to` inclusive; none = today. → { from, to } as Dates, `to` exclusive, and the day names.
export function periodOf({ from = null, to = null } = {}, now = clockNow) {
  const today = tashkentDay(now());
  const a = from ?? to ?? today;
  const b = to ?? from ?? today;
  const start = dayStart(a);
  const end = new Date(dayStart(b).getTime() + DAY_MS);
  return { from: start, to: end, fromDay: a, toDay: b };
}

const share = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);

// Revenue = deposits that stay paid (succeeded: not refund_due, not refunded); holds, paid bookings and sales of the
// period; conversion — holds → paid bookings, paid bookings → sales (by the cohort of the period).
export async function summary(q, period = {}, opts = {}) {
  const p = periodOf(period, opts.now ?? clockNow);
  const [dep, holds, paid, sold, converted] = await Promise.all([
    q.one(`SELECT count(*)::int AS n, COALESCE(sum(amount), 0)::bigint AS sum FROM payments
      WHERE status = 'succeeded' AND succeeded_at >= $1 AND succeeded_at < $2`, [p.from, p.to]),
    q.one('SELECT count(*)::int AS n FROM bookings WHERE held_at >= $1 AND held_at < $2', [p.from, p.to]),
    q.one('SELECT count(*)::int AS n FROM bookings WHERE held_at >= $1 AND held_at < $2 AND booked_at IS NOT NULL', [p.from, p.to]),
    q.one(`SELECT count(*)::int AS n, COALESCE(sum(COALESCE(b.price_at_booking, a.price)), 0)::bigint AS sum
      FROM apartments a LEFT JOIN bookings b ON b.id = a.sold_booking_id WHERE a.sold_at >= $1 AND a.sold_at < $2`, [p.from, p.to]),
    q.one(`SELECT count(*)::int AS n FROM bookings WHERE held_at >= $1 AND held_at < $2 AND status = 'converted'`, [p.from, p.to])
  ]);
  return {
    from: p.fromDay, to: p.toDay,
    deposits: { count: dep.n, sum: Number(dep.sum) },
    holds: holds.n, bookings: paid.n,
    sales: { count: sold.n, sum: Number(sold.sum) },
    conversion: { holdToBooking: share(paid.n, holds.n), bookingToSale: share(converted.n, paid.n) }
  };
}

// ---- the dashboard (12 §9, 13 §10, D-26) ----
// The head sees money; a manager sees counts only (tiles «в брони», «свободно», «сгорает 24 ч», the funnel, the feed): the cut is made
// here, not in the screen.
export const DASH_PERIODS = ['today', '7d', '30d'];
const PERIOD_DAYS = { today: 1, '7d': 7, '30d': 30 };

// 'today' = from 00:00 of the Tashkent day; '7d' / '30d' = the last N calendar days including today. prev — the period of the same length before it.
export function dashPeriod(name = 'today', now = clockNow) {
  if (!DASH_PERIODS.includes(name)) throw new DomainError('invalid_input', { fields: ['period'] });
  const days = PERIOD_DAYS[name];
  const today = tashkentDay(now());
  const to = new Date(dayStart(today).getTime() + DAY_MS);
  const from = new Date(to.getTime() - days * DAY_MS);
  return { name, days, from, to, fromDay: tashkentDay(from), toDay: today, step: days === 1 ? 'hour' : 'day',
    prev: { from: new Date(from.getTime() - days * DAY_MS), to: from } };
}

const pct = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null);
const n = v => Number(v ?? 0);

// Deposits that stay in: received in the period minus refunds completed in it (12 §9.2).
async function depositsNet(q, from, to) {
  const [got, back] = await Promise.all([
    q.one("SELECT count(*)::int AS c, COALESCE(sum(amount), 0)::bigint AS s FROM payments WHERE kind = 'deposit' AND succeeded_at >= $1 AND succeeded_at < $2", [from, to]),
    q.one(`SELECT COALESCE(sum(r.amount), 0)::bigint AS s FROM refunds r JOIN payments p ON p.id = r.payment_id
      WHERE p.kind = 'deposit' AND r.status = 'succeeded' AND r.completed_at >= $1 AND r.completed_at < $2`, [from, to])
  ]);
  return { count: got.c, sum: n(got.s) - n(back.s) };
}

const soldIn = (q, from, to) => q.one(`SELECT count(*)::int AS c, COALESCE(sum(COALESCE(b.price_at_booking, a.price)), 0)::bigint AS s
  FROM apartments a LEFT JOIN bookings b ON b.id = a.sold_booking_id WHERE a.sold_at >= $1 AND a.sold_at < $2`, [from, to]);

// The funnel by the cohorts of the period (12 §9.3): a step is counted among those who started in it, so a step of the booking chain
// never exceeds the previous one.
async function funnelOf(q, p) {
  const [visits, dialogs, holds, paid, sold, expired, talk, median, handoff] = await Promise.all([
    q.one('SELECT count(*)::int AS c FROM analytics_visits WHERE day >= $1::date AND day <= $2::date', [p.fromDay, p.toDay]),
    q.one(`SELECT count(*)::int AS c FROM conversations c WHERE c.kind = 'client' AND c.created_at >= $1 AND c.created_at < $2
      AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user')`, [p.from, p.to]),
    q.one('SELECT count(*)::int AS c FROM bookings WHERE held_at >= $1 AND held_at < $2', [p.from, p.to]),
    q.one('SELECT count(*)::int AS c FROM bookings WHERE held_at >= $1 AND held_at < $2 AND booked_at IS NOT NULL', [p.from, p.to]),
    q.one("SELECT count(*)::int AS c FROM bookings WHERE held_at >= $1 AND held_at < $2 AND status = 'converted'", [p.from, p.to]),
    q.one("SELECT count(*)::int AS paid, count(*) FILTER (WHERE status = 'expired')::int AS expired FROM bookings WHERE booked_at >= $1 AND booked_at < $2", [p.from, p.to]),
    q.one(`WITH d AS (SELECT c.client_id, min(m.created_at) AS first_at FROM conversations c JOIN messages m ON m.conversation_id = c.id AND m.role = 'user'
        WHERE c.kind = 'client' AND c.client_id IS NOT NULL AND c.created_at >= $1 AND c.created_at < $2 GROUP BY c.client_id)
      SELECT count(*)::int AS clients, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM bookings b WHERE b.client_id = d.client_id AND b.held_at >= d.first_at))::int AS booked FROM d`, [p.from, p.to]),
    q.one(`SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM b.booked_at - f.first_at) / 60) AS minutes
      FROM bookings b JOIN LATERAL (SELECT min(m.created_at) AS first_at FROM conversations c JOIN messages m ON m.conversation_id = c.id AND m.role = 'user'
        WHERE c.kind = 'client' AND c.client_id = b.client_id) f ON f.first_at IS NOT NULL AND f.first_at <= b.booked_at
      WHERE b.booked_at >= $1 AND b.booked_at < $2`, [p.from, p.to]),
    q.one(`SELECT count(*)::int AS c FROM conversations c WHERE c.kind = 'client' AND c.mode = 'human' AND c.created_at >= $1 AND c.created_at < $2
      AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user')`, [p.from, p.to])
  ]);
  return {
    funnel: { visitors: visits.c, dialogs: dialogs.c, bookings: holds.c, paid: paid.c, sales: sold.c },
    conversions: {
      visitorToDialog: share(dialogs.c, visits.c), dialogToBooking: share(talk.booked, talk.clients), bookingToSale: share(sold.c, paid.c),
      expiredShare: share(expired.expired, expired.paid), medianFirstMessageToBookingMin: median?.minutes == null ? null : Math.round(Number(median.minutes)),
      handoffShare: share(handoff.c, dialogs.c)
    }
  };
}

// 12 §9.7: the activity of the AI in the period; the money and the Gemini counters go to the head only.
async function aiActivity(q, p, head, opts) {
  const [runs, tools, fb, unanswered] = await Promise.all([
    q.one(`SELECT count(DISTINCT turn_id)::int AS turns, count(DISTINCT turn_id) FILTER (WHERE NOT ok)::int AS errors, count(DISTINCT turn_id) FILTER (WHERE fallback)::int AS fallbacks,
        COALESCE(sum(cost_usd), 0)::float AS usd FROM agent_runs WHERE created_at >= $1 AND created_at < $2`, [p.from, p.to]),
    q.one("SELECT count(*)::int AS c FROM tool_calls WHERE source = 'agent' AND at >= $1 AND at < $2", [p.from, p.to]),
    q.one('SELECT count(*) FILTER (WHERE feedback = 1)::int AS up, count(*) FILTER (WHERE feedback = -1)::int AS down FROM messages WHERE created_at >= $1 AND created_at < $2', [p.from, p.to]),
    q.one('SELECT count(*)::int AS c FROM kb_queries WHERE answered = false AND at >= $1 AND at < $2', [p.from, p.to])
  ]);
  const { answering } = await aiState(q, opts);
  const out = { turns: runs.turns, toolCalls: tools.c, errors: runs.errors, fallbacks: runs.fallbacks, up: fb.up, down: fb.down, unanswered: unanswered.c, mode: answering.tools.mode };
  if (head) {
    const costs = await aiCosts(q, { days: 1 }, { type: 'staff', role: 'head' }, opts);
    out.costUsd = runs.usd;
    out.gemini = costs.today.gemini;
  }
  return out;
}

// The funnel and the AI activity of a period of Tashkent days (08 §3.2, the head's tools funnel / ai_activity): the same figures as
// the dashboard, for any from/to. → { from, to, funnel, conversions } / { from, to, turns, …, costUsd, byModel }.
export async function funnel(q, period = {}, opts = {}) {
  const p = periodOf(period, opts.now ?? clockNow);
  return { from: p.fromDay, to: p.toDay, ...await funnelOf(q, p) };
}
export async function aiActivityOf(q, period = {}, opts = {}) {
  const p = periodOf(period, opts.now ?? clockNow);
  const { gemini, ...a } = await aiActivity(q, p, true, opts);
  const byModel = await q.query(`SELECT provider, model, count(*)::int AS calls, count(*) FILTER (WHERE NOT ok)::int AS failed,
      COALESCE(sum(cost_usd), 0)::float AS "costUsd" FROM ai_calls WHERE at >= $1 AND at < $2 GROUP BY 1, 2 ORDER BY 3 DESC`, [p.from, p.to]);
  return { from: p.fromDay, to: p.toDay, ...a, costUsd: byModel.reduce((s, m) => s + m.costUsd, 0), agentCostUsd: a.costUsd, byModel };
}

// → { period, tiles, funnel, conversions, ai, compare? }. A manager gets no sold / deposits tiles, no compare and no AI money.
export async function dashboardSummary(q, { period = 'today' } = {}, actor, opts = {}) {
  need(actor, 'manager', 'head');
  const now = opts.now ?? clockNow;
  const head = actor.role === 'head';
  const p = dashPeriod(period, now);
  const at = now();
  const [booked, held, apts, burning, f] = await Promise.all([
    q.one("SELECT count(*)::int AS c, COALESCE(sum(a.price), 0)::bigint AS s FROM bookings b JOIN apartments a ON a.no = b.apartment_no WHERE b.status = 'booked'"),
    q.one("SELECT count(*)::int AS c FROM bookings WHERE status = 'held'"),
    q.one('SELECT count(*)::int AS total, count(*) FILTER (WHERE sold_at IS NOT NULL)::int AS sold FROM apartments'),
    q.one("SELECT count(*)::int AS c FROM bookings WHERE status = 'booked' AND expires_at < $1", [new Date(at.getTime() + DAY_MS)]),
    funnelOf(q, p)
  ]);
  const tiles = {
    booked: head ? { count: booked.c, sum: n(booked.s) } : { count: booked.c },
    free: { count: Math.max(0, apts.total - apts.sold - booked.c - held.c), total: apts.total, held: held.c },
    burning: { count: burning.c }
  };
  const out = { period: { name: p.name, from: p.fromDay, to: p.toDay }, tiles, ...f, ai: await aiActivity(q, p, head, opts) };
  if (head) {
    const [sold, dep, prevSold, prevDep] = await Promise.all([soldIn(q, p.from, p.to), depositsNet(q, p.from, p.to), soldIn(q, p.prev.from, p.prev.to), depositsNet(q, p.prev.from, p.prev.to)]);
    tiles.sold = { count: sold.c, sum: n(sold.s) };
    tiles.deposits = dep;
    out.compare = { sold: { prev: n(prevSold.s), pct: pct(n(sold.s), n(prevSold.s)) }, deposits: { prev: prevDep.sum, pct: pct(dep.sum, prevDep.sum) } };
  }
  return out;
}

// → { step: 'hour' | 'day', deposits?, bookings, byType }: a point per hour (today) or per Tashkent day; an empty one is a zero (12 §9.4).
// A manager gets no deposits.
export async function dashboardCharts(q, { period = 'today' } = {}, actor, opts = {}) {
  need(actor, 'manager', 'head');
  const now = opts.now ?? clockNow;
  const p = dashPeriod(period, now);
  const stepMs = p.step === 'hour' ? 3600e3 : DAY_MS;
  const size = Math.round((p.to.getTime() - p.from.getTime()) / stepMs);
  const label = i => {
    const t0 = new Date(p.from.getTime() + i * stepMs);
    return p.step === 'hour' ? { day: tashkentDay(t0), hour: new Date(t0.getTime() + TZ_MS).getUTCHours() } : { day: tashkentDay(t0) };
  };
  const slot = ts => Math.floor((new Date(ts).getTime() - p.from.getTime()) / stepMs);
  const series = fields => Array.from({ length: size }, (_, i) => ({ ...label(i), ...Object.fromEntries(fields.map(f => [f, 0])) }));
  const out = { step: p.step };

  if (actor.role === 'head') {
    const rows = series(['amount']);
    const [got, back] = await Promise.all([
      q.query("SELECT succeeded_at AS at, amount FROM payments WHERE kind = 'deposit' AND succeeded_at >= $1 AND succeeded_at < $2", [p.from, p.to]),
      q.query(`SELECT r.completed_at AS at, r.amount FROM refunds r JOIN payments x ON x.id = r.payment_id
        WHERE x.kind = 'deposit' AND r.status = 'succeeded' AND r.completed_at >= $1 AND r.completed_at < $2`, [p.from, p.to])
    ]);
    for (const r of got) rows[slot(r.at)].amount += n(r.amount);
    for (const r of back) rows[slot(r.at)].amount -= n(r.amount);
    out.deposits = rows;
  }

  const rows = series(['held', 'paid']);
  const [held, paid] = await Promise.all([
    q.query('SELECT held_at AS at FROM bookings WHERE held_at >= $1 AND held_at < $2', [p.from, p.to]),
    q.query('SELECT booked_at AS at FROM bookings WHERE booked_at >= $1 AND booked_at < $2', [p.from, p.to])
  ]);
  for (const r of held) rows[slot(r.at)].held++;
  for (const r of paid) rows[slot(r.at)].paid++;
  out.bookings = rows;

  // The cut «now» (12 §9.4): every room count that exists, sold / booked / on payment / free.
  out.byType = await q.query(`SELECT a.rooms,
      count(*) FILTER (WHERE a.sold_at IS NOT NULL)::int AS sold,
      count(*) FILTER (WHERE a.sold_at IS NULL AND b.status = 'booked')::int AS booked,
      count(*) FILTER (WHERE a.sold_at IS NULL AND b.status = 'held')::int AS held,
      count(*) FILTER (WHERE a.sold_at IS NULL AND b.id IS NULL)::int AS free
    FROM apartments a LEFT JOIN bookings b ON b.apartment_no = a.no AND b.status IN ('held', 'booked') GROUP BY a.rooms ORDER BY a.rooms`);
  return out;
}

// ---- the feed (04 §8, 12 §9.5) ----
const spaced = v => String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

// → { items: [{ id, type, at, text, link }], last }, newest first. No names, no phones; the amount and the provider only for the head.
export async function dashboardFeed(q, { after = 0, limit = 50, lang = 'ru' } = {}, actor, opts = {}) {
  need(actor, 'manager', 'head');
  const now = opts.now ?? clockNow;
  const cursor = Number.isInteger(Number(after)) && Number(after) >= 0 ? Number(after) : 0;
  const size = Math.min(100, Math.max(1, Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : 50));
  const rows = await eventsFeed(q, { after: cursor, limit: size, now });
  const bookings = new Map(), orders = new Map();
  const ids = col => [...new Set(rows.map(r => r[col]).filter(Boolean))];
  if (ids('booking_id').length) for (const r of await q.query('SELECT id, no FROM bookings WHERE id = ANY($1)', [ids('booking_id')])) bookings.set(r.id, r.no);
  if (ids('order_id').length) for (const r of await q.query('SELECT id, no FROM orders WHERE id = ANY($1)', [ids('order_id')])) orders.set(r.id, r.no);
  const items = rows.map(r => {
    const no = bookings.get(r.booking_id);
    const vars = { no: no ?? '?', apt: r.apartment_no ?? '?', order: orders.get(r.order_id) ?? '?' };
    let text = t(lang, `feed.${r.type}`, vars) ?? r.type;
    if (actor.role === 'head' && r.data?.amount != null) {
      text += ` · ${[r.data.provider && String(r.data.provider).toUpperCase(), `${spaced(r.data.amount)} ${t(lang, 'feed.sum') ?? ''}`.trim()].filter(Boolean).join(' · ')}`;
    }
    const link = no ? `/admin#/bookings/${no}` : r.apartment_no ? `/admin#/units/${r.apartment_no}` : null;
    return { id: Number(r.id), type: r.type, at: r.at, text, link };
  });
  return { items, last: items.length ? Math.max(cursor, ...items.map(i => i.id)) : cursor };
}
