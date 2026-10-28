// What changes from turn to turn goes into the first history message, not the system part (07 §7.3, the cache):
// today, channel, language, the client, the memory line (§6.1) and the previous agent's digest (§4.2). Pure.
import { money } from '../notify/format.js';

const sp = n => money(n).replaceAll(String.fromCharCode(160), ' ');
const day = iso => new Date(new Date(iso).getTime() + 5 * 3600e3).toISOString().slice(0, 10);
const hhmm = iso => new Date(new Date(iso).getTime() + 5 * 3600e3).toISOString().slice(11, 16);

// 07 §6.1: the memory as one line — «3 rooms, ≤ 1 000 000 000 UZS, floor ≥ 5; shown 41, 57, 63; focus 41».
export function memoryLine(state = {}) {
  const f = state.filters ?? {};
  const want = [];
  if (f.rooms != null) want.push(`${f.rooms} rooms`);
  if (f.priceMin != null) want.push(`≥ ${sp(f.priceMin)} UZS`);
  if (f.priceMax != null) want.push(`≤ ${sp(f.priceMax)} UZS`);
  if (f.floorMin != null) want.push(`floor ≥ ${f.floorMin}`);
  if (f.floorMax != null) want.push(`floor ≤ ${f.floorMax}`);
  if (f.areaMin != null) want.push(`area ≥ ${f.areaMin} m²`);
  if (f.areaMax != null) want.push(`area ≤ ${f.areaMax} m²`);
  if (f.building) want.push(`building ${f.building}`);
  const parts = [];
  if (want.length) parts.push(want.join(', '));
  if (state.shown?.length) parts.push(`shown ${state.shown.join(', ')}`);
  if (state.focusApartment != null) parts.push(`focus ${state.focusApartment}`);
  if (state.finance?.months || state.finance?.downPct != null) {
    parts.push(`finance ${[state.finance.months && `${state.finance.months} months`, state.finance.downPct != null && `down ${state.finance.downPct}%`]
      .filter(Boolean).join(', ')}`);
  }
  return parts.join('; ') || null;
}

// 07 §14: the analyst's context — today with its weekday (for «this week»), the language of the answer.
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export function analystContext({ now, lang }) {
  const weekday = WEEKDAYS[new Date(new Date(now).getTime() + 5 * 3600e3).getUTCDay()];
  return ['[context]', `today: ${day(now)} (${weekday}, Asia/Tashkent)`, `language: ${lang}`].join('\n');
}

// client: { known, phone: 'no' | 'yes' | 'yes(verified)', holds: [{ apartmentNo, until }] } — never the phone itself (§6.1).
export function contextBlock({ now, channel, lang, client = {}, state = {}, digest = null }) {
  const holds = client.holds ?? [];
  const lines = [
    '[context]',
    `today: ${day(now)} (Asia/Tashkent)`,
    `channel: ${channel}`,
    `language: ${lang}`,
    `client: known=${client.known ? 'yes' : 'no'}, phone=${client.phone ?? 'no'}, active_holds=${holds.length}`
      + (holds.length ? ` (${holds.map(h => `№${h.apartmentNo}, until ${hhmm(h.until)}`).join('; ')})` : '')
  ];
  const mem = memoryLine(state);
  if (mem) lines.push(`memory: ${mem}`);
  if (digest) lines.push(`previous_agent_digest: ${digest}`);
  lines.push('[/context]');
  return lines.join('\n');
}

// 07 §4.2: what the first agent found, from its tool results (not its text) plus the first line of its answer.
export function digestOf(run) {
  if (!run) return null;
  const apts = [];
  for (const c of run.calls ?? []) {
    const r = c.result;
    if (!c.ok || !r) continue;
    for (const a of r.items ?? (r.no != null && r.price != null ? [r] : [])) if (a.no != null) apts.push(`${a.no} (${sp(a.price)})`);
  }
  const first = String(run.text ?? '').split('\n').find(l => l.trim())?.trim().slice(0, 200) ?? '';
  const found = apts.length ? apts.slice(0, 5).join(', ') : 'nothing found';
  return `${run.agent} → ${found}${first ? `; said: «${first}»` : ''}`;
}
