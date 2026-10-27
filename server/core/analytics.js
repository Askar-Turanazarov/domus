// Numbers for the head (01 §3.2, 12 §9): the period is in Tashkent days. Only what the MCP tool sales_summary needs now
// (D3-14); the funnel, the charts and the AI activity come with the dashboard (D4-08).
import { now as clockNow } from './clock.js';

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
