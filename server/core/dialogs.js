// Dialogs «with a manager» (07 §9, 12 §5.4, 10 §8, FR-AGT-10, S): the inbox of dialogs in mode 'human', the manager's reply
// (messages.role = 'staff' + staff_reply to Telegram; the site widget picks it up by polling), «Вернуть ИИ-консультанту» by hand
// or by itself after 24 h without a manager's reply, and the client's messages to the staff group not more than once per 5 min.
import { DomainError, need, staffIdOf } from './errors.js';
import { emit } from './events.js';
import { maskPhone } from './phone.js';
import { context, inTx, notify } from './tx.js';
import { t } from '../i18n/index.js';

const ROLES = ['manager', 'head'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const HUMAN_TTL_MS = 24 * 3600e3;
const CLIENT_PING_MS = 5 * 60e3;
const PREVIEW = 100;
const pageSize = n => Math.min(100, Math.max(1, Number.isInteger(Number(n)) && Number(n) > 0 ? Number(n) : 50));
const offsetOf = c => {
  if (c == null || c === '') return 0;
  const n = Number(Buffer.from(String(c), 'base64url').toString());
  if (!Number.isInteger(n) || n < 0) throw new DomainError('invalid_input', { fields: ['cursor'] });
  return n;
};

// The inbox (12 §5.4): dialogs in mode 'human', those waiting longest for an answer on top. → { items, next, waiting }
export async function inbox(q, { cursor = null, limit = 50 } = {}, actor, opts = {}) {
  need(actor, ...ROLES);
  context(opts);
  const from = offsetOf(cursor), n = pageSize(limit);
  const rows = await q.query(`
    SELECT cv.id, cv.client_id, cv.channel, cv.lang, cv.message_count, cv.last_message_at, cv.created_at,
           cl.name, cl.phone, cl.assigned_staff_id, st.name AS assignee_name, u.at AS user_at, u.text AS user_text, s.at AS staff_at
      FROM conversations cv
      JOIN clients cl ON cl.id = cv.client_id
      LEFT JOIN staff st ON st.id = cl.assigned_staff_id
      LEFT JOIN LATERAL (SELECT created_at AS at, text FROM messages WHERE conversation_id = cv.id AND role = 'user' ORDER BY id DESC LIMIT 1) u ON true
      LEFT JOIN LATERAL (SELECT created_at AS at FROM messages WHERE conversation_id = cv.id AND role = 'staff' ORDER BY id DESC LIMIT 1) s ON true
     WHERE cv.kind = 'client' AND cv.mode = 'human'
     ORDER BY (u.at IS NOT NULL AND (s.at IS NULL OR u.at > s.at)) DESC, u.at ASC NULLS LAST, cv.id
     LIMIT $1 OFFSET $2`, [n + 1, from]);
  const { waiting } = await q.one(`SELECT count(*)::int AS waiting FROM conversations cv WHERE cv.kind = 'client' AND cv.mode = 'human'
    AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = cv.id AND m.role = 'user'
      AND m.id > COALESCE((SELECT max(id) FROM messages s WHERE s.conversation_id = cv.id AND s.role = 'staff'), 0))`);
  const page = rows.slice(0, n);
  return {
    items: page.map(r => ({ id: r.id, clientId: r.client_id, channel: r.channel, lang: r.lang, name: r.name ?? null,
      phone: r.phone ? maskPhone(r.phone) : null, assignee: r.assigned_staff_id ? { id: r.assigned_staff_id, name: r.assignee_name } : null,
      waiting: !!r.user_at && (!r.staff_at || new Date(r.user_at) > new Date(r.staff_at)), waitingSince: r.user_at ?? null,
      lastText: r.user_text ? String(r.user_text).slice(0, PREVIEW) : null, lastStaffAt: r.staff_at ?? null,
      messageCount: r.message_count, lastMessageAt: r.last_message_at ?? r.created_at })),
    next: rows.length > n ? Buffer.from(String(from + n)).toString('base64url') : null,
    waiting
  };
}

async function clientDialog(q, conversationId, { lock = false } = {}) {
  if (!UUID.test(String(conversationId))) return null;
  return q.one(`SELECT cv.*, cl.lang AS client_lang FROM conversations cv JOIN clients cl ON cl.id = cv.client_id
    WHERE cv.id = $1 AND cv.kind = 'client'${lock ? ' FOR UPDATE OF cv' : ''}`, [conversationId]);
}

// The manager's reply (12 §5.4, 10 §8): a staff message in the dialog; Telegram dialogs get staff_reply through the Outbox.
// → { message: { id, role, text, createdAt, staffName } }
export async function staffReply(db, { conversationId, text }, actor, opts = {}) {
  need(actor, ...ROLES);
  const ctx = context(opts);
  const body = String(text ?? '').trim();
  if (!body || body.length > 2000) throw new DomainError('invalid_input', { fields: ['text'] });
  return inTx(db, ctx, async (q, fx) => {
    const conv = await clientDialog(q, conversationId, { lock: true });
    if (!conv) throw new DomainError('conversation_not_found');
    const at = ctx.now();
    const staff = await q.one('SELECT id, name FROM staff WHERE id = $1', [staffIdOf(actor)]);
    const m = await q.one(`INSERT INTO messages (conversation_id, role, text, blocks, created_at) VALUES ($1, 'staff', $2, $3, $4) RETURNING id`,
      [conv.id, body, JSON.stringify([{ type: 'staff', data: { staffId: staff?.id ?? null, name: staff?.name ?? null } }]), at]);
    await q.query('UPDATE conversations SET message_count = message_count + 1, last_message_at = $2, updated_at = $2 WHERE id = $1', [conv.id, at]);
    const ev = await emit(q, 'conversation.staff_replied', { clientId: conv.client_id, staffId: staff?.id ?? null },
      { conversationId: conv.id, messageId: Number(m.id) }, actor, ctx);
    if (conv.channel === 'telegram') {
      await notify(q, fx, ctx, { template: 'staff_reply', audience: 'client', clientId: conv.client_id,
        vars: { text: body, staffName: staff?.name ?? '—' }, eventId: ev, dedupeKey: `staff_reply:${m.id}` });
    }
    return { message: { id: Number(m.id), role: 'staff', text: body, createdAt: at, staffName: staff?.name ?? null } };
  });
}

// «Вернуть ИИ-консультанту» (07 §9): mode 'ai', a line for the client in the dialog and, in Telegram, ai_returned.
// by — 'staff' | 'timeout'. A dialog already with the AI → { mode: 'ai', changed: false }.
export async function returnToAi(db, { conversationId, by = 'staff' }, actor, opts = {}) {
  if (by === 'staff') need(actor, ...ROLES);
  const ctx = context(opts);
  return inTx(db, ctx, async (q, fx) => backToAi(q, fx, ctx, conversationId, by, actor));
}

async function backToAi(q, fx, ctx, conversationId, by, actor) {
  const conv = await clientDialog(q, conversationId, { lock: true });
  if (!conv) throw new DomainError('conversation_not_found');
  if (conv.mode !== 'human') return { mode: 'ai', changed: false };
  const at = ctx.now();
  await q.query(`UPDATE conversations SET mode = 'ai', updated_at = $2, state = state - 'humanSince' WHERE id = $1`, [conv.id, at]);
  await q.query(`INSERT INTO messages (conversation_id, role, text, created_at) VALUES ($1, 'assistant', $2, $3)`,
    [conv.id, t(conv.lang, 'tpl.ai_returned.text'), at]);
  await q.query('UPDATE conversations SET message_count = message_count + 1, last_message_at = $2 WHERE id = $1', [conv.id, at]);
  const ev = await emit(q, 'conversation.mode_changed', { clientId: conv.client_id, staffId: by === 'staff' ? staffIdOf(actor) : null },
    { conversationId: conv.id, to: 'ai', by }, by === 'staff' ? actor : { type: 'system' }, ctx);
  if (conv.channel === 'telegram') {
    await notify(q, fx, ctx, { template: 'ai_returned', audience: 'client', clientId: conv.client_id, vars: {}, eventId: ev,
      dedupeKey: `ai_returned:${ev}` });
  }
  return { mode: 'ai', changed: true };
}

// A client's message while the dialog is with a manager (07 §9, 10 §8). After 24 h without a manager's reply the dialog goes back
// to the AI by itself → { mode: 'ai' } (the turn then answers as usual); otherwise the staff group hears of it, once per 5 min
// per client → { mode: 'human' }.
export async function clientWroteToHuman(db, { conversationId, text }, opts = {}) {
  const ctx = context(opts);
  return inTx(db, ctx, async (q, fx) => {
    const conv = await clientDialog(q, conversationId, { lock: true });
    if (!conv || conv.mode !== 'human') return { mode: 'ai' };
    const at = ctx.now();
    const staffAt = (await q.one(`SELECT max(created_at) AS at FROM messages WHERE conversation_id = $1 AND role = 'staff'`, [conv.id]))?.at;
    const since = Math.max(conv.state?.humanSince ? new Date(conv.state.humanSince).getTime() : new Date(conv.updated_at).getTime(),
      staffAt ? new Date(staffAt).getTime() : 0);
    if (at.getTime() - since >= HUMAN_TTL_MS) {
      await backToAi(q, fx, ctx, conv.id, 'timeout', { type: 'system' });
      return { mode: 'ai', returned: true };
    }
    const recent = await q.one(`SELECT 1 AS x FROM outbox WHERE template = 'staff_client_message' AND client_id = $1 AND created_at > $2 LIMIT 1`,
      [conv.client_id, new Date(at.getTime() - CLIENT_PING_MS)]);
    if (!recent) {
      const c = await q.one('SELECT id, name, phone FROM clients WHERE id = $1', [conv.client_id]);
      await notify(q, fx, ctx, { template: 'staff_client_message', audience: 'staff_group', clientId: c.id,
        vars: { name: c.name || (c.phone ? maskPhone(c.phone) : '—'), preview: String(text ?? '').slice(0, PREVIEW), clientId: c.id },
        dedupeKey: `staff_client_message:${c.id}:${at.getTime()}` });
    }
    return { mode: 'human' };
  });
}
