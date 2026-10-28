// The table under the analyst's answer (07 §14, 12 §11): built by code from the last good tool result of the turn, never from
// the model's words. Lists → rows of the list (up to 20) and a link to the admin list; reports → «what — how much» rows,
// one column per period when the same report was asked for several periods («сравни эту и прошлую неделю»).
// → { type: 'table', data: { tool, from?, to?, total?, columns: [label], rows: [[cell]], link? } } | null
import { t } from '../i18n/index.js';
import { money } from '../notify/format.js';
import { fullTime } from '../payments/pdf.js';

const MAX_ROWS = 20;
const pct = v => (v == null ? '—' : `${Math.round(v * 1000) / 10}%`);
const usd = v => `$${(Number(v) || 0).toFixed(2)}`;
const who = c => [c?.name, c?.phone].filter(Boolean).join(' · ') || '—';

// Each tool: its columns (keys of an.col.*), a row of an item, the admin list it opens.
const LISTS = {
  list_bookings: {
    cols: ['booking', 'apartment', 'status', 'client', 'until', 'deposit'], link: '#/bookings',
    row: (b, lang, sum) => [`№${b.bookingNo}`, `№${b.apartmentNo}`, t(lang, `an.status.${b.status}`) ?? b.status, who(b.client),
      fullTime(b.until, lang), `${money(b.deposit)} ${sum}`]
  },
  list_payments: {
    cols: ['code', 'booking', 'provider', 'amount', 'status', 'client'], link: '#/payments',
    row: (p, lang, sum) => [p.code, p.bookingNo ? `№${p.bookingNo}` : '—', p.provider, `${money(p.amount)} ${sum}`,
      t(lang, `an.status.${p.status}`) ?? p.status, who(p.client)]
  },
  list_viewings: {
    cols: ['apartment', 'at', 'status', 'client'], link: null,
    row: v => [`№${v.apartmentNo}`, v.at, v.status, who(v.client)]
  }
};

// Reports: [label key, value of the result].
const REPORTS = {
  sales_summary: (r, sum) => [['deposits', `${r.deposits.count} · ${money(r.deposits.sum)} ${sum}`], ['holds', r.holds],
    ['bookings', r.bookings], ['sales', `${r.sales.count} · ${money(r.sales.sum)} ${sum}`],
    ['holdToBooking', pct(r.conversion.holdToBooking)], ['bookingToSale', pct(r.conversion.bookingToSale)]],
  funnel: r => [['visitors', r.funnel.visitors], ['dialogs', r.funnel.dialogs], ['holds', r.funnel.bookings], ['bookings', r.funnel.paid],
    ['sales', r.funnel.sales], ['dialogToBooking', pct(r.conversions.dialogToBooking)], ['bookingToSale', pct(r.conversions.bookingToSale)],
    ['expiredShare', pct(r.conversions.expiredShare)], ['handoffShare', pct(r.conversions.handoffShare)]],
  ai_activity: r => [['turns', r.turns], ['toolCalls', r.toolCalls], ['errors', r.errors], ['fallbacks', r.fallbacks],
    ['feedback', `👍 ${r.up} · 👎 ${r.down}`], ['unanswered', r.unanswered], ['costUsd', usd(r.costUsd)],
    ...(r.byModel ?? []).map(m => [null, `${m.model}: ${m.calls} · ${usd(m.costUsd)}`])]
};

export function analystTable(run, lang) {
  const call = [...(run?.calls ?? [])].reverse().find(c => c.ok && c.result && (LISTS[c.name] || REPORTS[c.name]));
  if (!call) return null;
  const r = call.result;
  const sum = t(lang, 'pdf.sum');
  const col = k => t(lang, `an.col.${k}`);
  const period = r.from ? { from: r.from, to: r.to } : {};
  const list = LISTS[call.name];
  if (list) {
    return { type: 'table', data: { tool: call.name, ...period, total: r.total, columns: list.cols.map(col),
      rows: r.items.slice(0, MAX_ROWS).map(x => list.row(x, lang, sum)), ...(list.link ? { link: list.link } : {}) } };
  }
  const same = run.calls.filter(c => c.ok && c.result && c.name === call.name);
  const seen = new Set();
  const periods = same.filter(c => !seen.has(`${c.result.from}/${c.result.to}`) && seen.add(`${c.result.from}/${c.result.to}`)).map(c => c.result);
  if (periods.length > 1 && call.name !== 'ai_activity') {
    const cols = periods.map(p => REPORTS[call.name](p, sum));
    return { type: 'table', data: { tool: call.name, columns: [col('metric'), ...periods.map(p => (p.from === p.to ? p.from : `${p.from} — ${p.to}`))],
      rows: cols[0].map(([k], i) => [col(k), ...cols.map(c => String(c[i][1]))]) } };
  }
  const rows = REPORTS[call.name](r, sum).map(([k, v]) => [k ? col(k) : '', String(v)]);
  return { type: 'table', data: { tool: call.name, ...period, columns: [col('metric'), col('value')], rows,
    ...(call.name === 'ai_activity' ? { link: '#/ai' } : {}) } };
}
