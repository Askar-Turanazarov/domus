// Viewings in the base (03 §12, FR-ADM-07, J7): the Domus checks plus working hours and a 60-day horizon. The legacy
// file-based bookViewing (viewings.js) stays for the old MCP tools until D3-14.
import { DomainError, staffIdOf } from './errors.js';
import { emit } from './events.js';
import { normalizePhone, maskPhone } from './phone.js';
import { nameOf } from './clients.js';
import { context, inTx, notify, later } from './tx.js';
import { settingsOf } from './bookings.js';

const TZ_MS = 5 * 3600e3;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})?$/;   // to the minute: a slot is a minute
const DAY = 864e5;
const OPEN = 9 * 60, CLOSE = 20 * 60;                                // 09:00…20:00 Tashkent, the start before 20:00

// '2026-10-25T15:00' (Tashkent) or with an offset → Date | null. Pure.
export function viewingTime(s) {
  if (typeof s !== 'string' || !ISO.test(s)) return null;
  const ms = Date.parse(/(Z|[+-]\d{2}:\d{2})$/.test(s) ? s : s + '+05:00');
  return Number.isNaN(ms) ? null : new Date(ms);
}

// '2026-11-02 15:00' in Tashkent. Pure.
export const tashkentText = d => new Date(d.getTime() + TZ_MS).toISOString().slice(0, 16).replace('T', ' ');

// Everything that can be checked without writing (08 §6.1 preview). → { apartmentNo, at, local }.
export async function previewViewing(q, { apartmentNo, datetime }, opts = {}) {
  const ctx = context(opts);
  const apt = await q.one('SELECT no, sold_at FROM apartments WHERE no = $1', [apartmentNo]);
  if (!apt) throw new DomainError('apartment_not_found', { no: apartmentNo });
  if (apt.sold_at) throw new DomainError('apartment_sold', { no: apartmentNo });
  const at = viewingTime(datetime);
  if (!at) throw new DomainError('datetime_invalid');
  const t = ctx.now().getTime();
  if (at.getTime() <= t) throw new DomainError('datetime_past');
  if (at.getTime() > t + 60 * DAY) throw new DomainError('datetime_too_far');
  const local = new Date(at.getTime() + TZ_MS);
  const min = local.getUTCHours() * 60 + local.getUTCMinutes();
  if (min < OPEN || min >= CLOSE) throw new DomainError('outside_hours');
  const taken = await q.one(`SELECT 1 AS x FROM viewings WHERE apartment_no = $1 AND at = $2 AND status = 'scheduled'`, [apartmentNo, at]);
  if (taken) throw new DomainError('slot_taken', { no: apartmentNo, when: tashkentText(at) });
  return { apartmentNo, at: at.toISOString(), local: tashkentText(at) };
}

// input — { apartmentNo, datetime, clientId, name?, phone?, channel }: name and phone default to the client's card.
// → the viewing row. Event viewing.created, viewing_confirmed to the client, staff_viewing_created to the group,
// viewing.remind 3 h before (if the viewing is further than that).
export async function scheduleViewing(db, input, actor, opts = {}) {
  const { apartmentNo, datetime, clientId, channel } = input;
  if (!Number.isInteger(apartmentNo) || !clientId || !channel) throw new DomainError('invalid_input');
  const ctx = context(opts);
  return inTx(db, ctx, async (q, fx) => {
    const p = await previewViewing(q, { apartmentNo, datetime }, ctx);
    const c = await q.one('SELECT id, name, phone FROM clients WHERE id = $1', [clientId]);
    if (!c) throw new DomainError('invalid_input');
    const phone = normalizePhone(input.phone ?? c.phone);
    if (!phone) throw new DomainError(input.phone ? 'phone_invalid' : 'need_phone');
    const name = input.name != null ? nameOf(input.name) : (c.name || '—');
    const s = await settingsOf(q, ctx);
    const at = new Date(p.at);
    let v;
    try {
      v = await q.one(`INSERT INTO viewings (apartment_no, client_id, at, name, phone, status, channel, created_by, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, 'scheduled', $6, $7, $8, $8) RETURNING *`,
      [apartmentNo, clientId, at, name, phone, channel, JSON.stringify(actor), ctx.now()]);
    } catch (e) {
      if (e.code === '23505') throw new DomainError('slot_taken', { no: apartmentNo, when: p.local });
      throw e;
    }
    const ev = await emit(q, 'viewing.created', { viewingId: v.id, apartmentNo, clientId, staffId: staffIdOf(actor) },
      { at: p.at, channel }, actor, ctx);
    await notify(q, fx, ctx, { template: 'viewing_confirmed', audience: 'client', clientId,
      vars: { apt: apartmentNo, at: p.local, address: s.bank_requisites?.address ?? '', mapUrl: null },
      eventId: ev, dedupeKey: `viewing_confirmed:${v.id}` });
    await notify(q, fx, ctx, { template: 'staff_viewing_created', audience: 'staff_group',
      vars: { apt: apartmentNo, at: p.local, name, phoneMasked: maskPhone(phone), clientId },
      eventId: ev, dedupeKey: `staff_viewing_created:${v.id}` });
    const hours = s.reminders?.viewingHoursBefore ?? 3;
    const remindAt = at.getTime() - hours * 3600e3;
    if (remindAt > ctx.now().getTime()) {
      await later(q, fx, ctx, 'viewing.remind', new Date(remindAt), { viewingId: v.id, expectedAt: p.at }, `viewing.remind:${v.id}:${p.at}`);
    }
    return v;
  });
}

// Viewings of one client, ahead and scheduled first (for a future «мои показы»; the head's list_viewings is D3-14).
export async function listViewings(q, { clientId = null, from = null, to = null, status = null, limit = 50 } = {}) {
  return q.query(`SELECT * FROM viewings WHERE ($1::uuid IS NULL OR client_id = $1) AND ($2::timestamptz IS NULL OR at >= $2)
      AND ($3::timestamptz IS NULL OR at < $3) AND ($4::text IS NULL OR status = $4) ORDER BY at LIMIT $5`,
  [clientId, from, to, status, limit]);
}

// 04 §6: viewing.remind — skipped when the viewing is no longer scheduled or its time moved.
export function viewingJobHandlers(opts = {}, fx = { outbox: [], jobs: [] }) {
  return {
    fx,
    handlers: {
      'viewing.remind': async (job, { q, now }) => {
        const ctx = context({ ...opts, now });
        const v = await q.one('SELECT * FROM viewings WHERE id = $1', [job.payload.viewingId]);
        if (!v || v.status !== 'scheduled' || new Date(v.at).toISOString() !== job.payload.expectedAt) return 'skipped';
        await notify(q, fx, ctx, { template: 'viewing_reminder', audience: 'client', clientId: v.client_id,
          vars: { apt: v.apartment_no, time: tashkentText(new Date(v.at)).slice(11) }, dedupeKey: `viewing_reminder:${v.id}:${job.payload.expectedAt}` });
        return 'done';
      }
    }
  };
}
