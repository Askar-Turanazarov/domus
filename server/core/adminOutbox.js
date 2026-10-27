// The Outbox window of the admin (12 §6, 04 §3.3, FR-DEMO-02, NFR-OBS-04): the last messages with their fate, the preview as the bot
// sent it, «send again» for a failed row. Head only. The personal link in a preview is masked (/b/1042-••••); template variables
// and chat ids never leave.
import { DomainError, need } from './errors.js';
import { context, inTx } from './tx.js';

export const OUTBOX_STATUSES = ['pending', 'sending', 'sent', 'retry', 'failed', 'skipped', 'cancelled'];
export const TARGETS = ['client', 'staff_group', 'staff_dm'];

const encodeCursor = (key, tie) => Buffer.from(JSON.stringify([new Date(key).toISOString(), String(tie)])).toString('base64url');
function decodeCursor(c) {
  if (c == null || c === '') return null;
  try {
    const [key, tie] = JSON.parse(Buffer.from(String(c), 'base64url').toString());
    if (Number.isNaN(new Date(key).getTime()) || !/^\d{1,18}$/.test(String(tie))) throw new Error('shape');
    return { key: new Date(key), tie: String(tie) };
  } catch {
    throw new DomainError('invalid_input', { fields: ['cursor'] });
  }
}
const pageSize = n => Math.min(200, Math.max(1, Number.isInteger(Number(n)) && Number(n) > 0 ? Number(n) : 200));

export const maskLinks = s => String(s ?? '').replace(/\/([bo])\/(\d{1,9})-[A-Za-z0-9_-]{32}/g, '/$1/$2-••••');

const recipientOf = r => (r.audience === 'staff_group' ? { kind: 'staff_group', name: null }
  : r.audience === 'staff_dm' ? { kind: 'staff', name: r.s_name ?? null }
    : { kind: 'client', id: r.client_id ?? null, name: r.c_name ?? null });

const summary = r => ({
  id: Number(r.id), createdAt: r.created_at, recipient: recipientOf(r), template: r.template, op: r.op, status: r.status, skipReason: r.skip_reason,
  attempts: r.attempts, sentAt: r.sent_at,
  canResend: r.status === 'failed' || (r.status === 'skipped' && r.skip_reason === 'blocked' && r.chat_id != null)
});

const FROM = `FROM outbox o LEFT JOIN clients c ON c.id = o.client_id LEFT JOIN staff s ON s.id = o.staff_id`;
const COLS = `o.*, c.name AS c_name, s.name AS s_name`;

// opts-1: { status, target, template, cursor, limit } → { items, next }, newest first (the window shows the last 200).
export async function outboxList(q, { status = null, target = null, template = null, cursor = null, limit = 200 } = {}, actor, opts = {}) {
  need(actor, 'head');
  context(opts);
  if (status != null && !OUTBOX_STATUSES.includes(status)) throw new DomainError('invalid_input', { fields: ['status'] });
  if (target != null && !TARGETS.includes(target)) throw new DomainError('invalid_input', { fields: ['target'] });
  if (template != null && !/^\w{1,60}$/.test(template)) throw new DomainError('invalid_input', { fields: ['template'] });
  const params = [];
  let where = 'TRUE';
  const add = (sql, v) => { params.push(v); where += ` AND ${sql.replace('?', '$' + params.length)}`; };
  if (status) add('o.status = ?', status);
  if (target) add('o.audience = ?', target);
  if (template) add('o.template = ?', template);
  const cur = decodeCursor(cursor);
  if (cur) { params.push(cur.key, cur.tie); where += ` AND (o.created_at, o.id) < ($${params.length - 1}, $${params.length}::bigint)`; }
  const n = pageSize(limit);
  const rows = await q.query(`SELECT ${COLS} ${FROM} WHERE ${where} ORDER BY o.created_at DESC, o.id DESC LIMIT ${n + 1}`, params);
  const page = rows.slice(0, n);
  const last = page[page.length - 1];
  return { items: page.map(summary), next: rows.length > n ? encodeCursor(last.created_at, last.id) : null };
}

// The message as the person saw it: the text with the bot's HTML markup (b, i, u, s, code, pre, a), the buttons under it.
function previewOf(rendered) {
  if (!rendered || typeof rendered.text !== 'string') return null;
  const buttons = (rendered.reply_markup?.inline_keyboard ?? []).flat().map(b => b.web_app ? { text: b.text, kind: 'web_app', target: maskLinks(b.web_app.url) }
    : b.url ? { text: b.text, kind: 'link', target: maskLinks(b.url) } : { text: b.text, kind: 'action', target: null });
  return { html: maskLinks(rendered.text), buttons };
}

// → null when there is no such row.
export async function outboxCard(q, id, actor, opts = {}) {
  need(actor, 'head');
  context(opts);
  if (!/^\d{1,18}$/.test(String(id))) return null;
  const r = await q.one(`SELECT ${COLS}, e.type AS ev_type, e.at AS ev_at, b.no AS booking_no ${FROM}
    LEFT JOIN events e ON e.id = o.event_id LEFT JOIN bookings b ON b.id = e.booking_id WHERE o.id = $1`, [id]);
  if (!r) return null;
  return {
    ...summary(r), lang: r.lang, nextAttemptAt: r.next_attempt_at, lastError: r.last_error ? String(r.last_error).slice(0, 300) : null,
    attachment: r.attachment?.kind ?? null, preview: previewOf(r.rendered),
    event: r.ev_type ? { type: r.ev_type, at: r.ev_at } : null, bookingNo: r.booking_no ?? null
  };
}

// «Send again» (04 §3.3): a failed row, or one skipped because the bot was blocked, gets one more try right now.
export async function resendOutbox(db, id, actor, opts = {}) {
  need(actor, 'head');
  const ctx = context(opts);
  if (!/^\d{1,18}$/.test(String(id))) throw new DomainError('not_found');
  return inTx(db, ctx, async (q, fx) => {
    const r = await q.one(`UPDATE outbox SET status = 'retry', next_attempt_at = $2
      WHERE id = $1 AND (status = 'failed' OR (status = 'skipped' AND skip_reason = 'blocked' AND chat_id IS NOT NULL)) RETURNING id`, [id, ctx.now()]);
    if (!r) {
      if (!await q.one('SELECT 1 AS x FROM outbox WHERE id = $1', [id])) throw new DomainError('not_found');
      throw new DomainError('invalid_input', { fields: ['status'] });
    }
    fx.outbox.push(r.id);
    return { status: 'retry' };
  });
}
