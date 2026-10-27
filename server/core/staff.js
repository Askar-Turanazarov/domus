// Staff and Telegram (10 §4.1 st_<code>, FR-ADM-11): the admin issues a 15-minute one-time code, the staff member sends
// it to the bot as /start st_<code>, and «Беру клиента» later finds the person by telegram_user_id.
import crypto from 'node:crypto';
import { DomainError } from './errors.js';
import { emit } from './events.js';
import { context, inTx } from './tx.js';

const CODE_MIN = 15;
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

// A one-time code for t.me/<bot>?start=st_<code>: only the sha256 is stored. Inside the caller's transaction.
export async function issueStaffLinkCode(q, { staffId }, opts = {}) {
  const ctx = context(opts);
  const code = crypto.randomBytes(16).toString('base64url');
  const expiresAt = new Date(ctx.now().getTime() + CODE_MIN * 60e3);
  await q.query('UPDATE staff SET tg_link_code_hash = $2, tg_link_expires_at = $3 WHERE id = $1', [staffId, sha256(code), expiresAt]);
  return { code, expiresAt };
}

// /start st_<code>: the code must exist, be alive and be used once. telegram — { userId, username? }.
// → the staff row. Another account of the staff already on this Telegram → err:telegram_linked_elsewhere.
export async function attachStaffTelegram(db, { code, telegram }, opts = {}) {
  const ctx = context(opts);
  return inTx(db, ctx, async q => {
    const at = ctx.now();
    const s = await q.one(`SELECT * FROM staff WHERE tg_link_code_hash = $1 AND active FOR UPDATE`, [sha256(String(code ?? ''))]);
    if (!s || !s.tg_link_expires_at || s.tg_link_expires_at <= at) throw new DomainError('link_invalid');
    const other = await q.one('SELECT id FROM staff WHERE telegram_user_id = $1 AND id <> $2', [telegram.userId, s.id]);
    if (other) throw new DomainError('telegram_linked_elsewhere');
    const row = await q.one(`UPDATE staff SET telegram_user_id = $2, telegram_username = $3, tg_link_code_hash = NULL,
      tg_link_expires_at = NULL WHERE id = $1 RETURNING *`, [s.id, telegram.userId, telegram.username ?? null]);
    await emit(q, 'staff.telegram_linked', { staffId: s.id }, {}, { type: 'staff', id: s.id, role: s.role, channel: 'telegram' }, ctx);
    return row;
  });
}

// «Беру клиента» looks the person up by the Telegram account that pressed the button (10 §6.2). → the active staff row | null.
export const staffByTelegram = (q, userId) => q.one('SELECT * FROM staff WHERE telegram_user_id = $1 AND active', [userId]);

// The bot left or was removed from the staff group (10 §6.3): Outbox skips the group («blocked») until the bot is back.
// state — 'removed' | 'ok'. A settings row, so every function instance sees it.
export async function setStaffChatState(q, state, opts = {}) {
  const ctx = context(opts);
  await q.query(`INSERT INTO settings (key, value, updated_at) VALUES ('staff_chat', $1, $2)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`, [JSON.stringify({ state }), ctx.now()]);
}
