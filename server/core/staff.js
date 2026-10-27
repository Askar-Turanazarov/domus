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

// ---- accounts (12 §2, 14 §2.1, D-16): created by `npm run staff`, signed in by server/http/admin.js ----

const COMMON = new Set(['password1234', '123456789012', 'qwertyuiop12', 'administrator', 'letmein12345', 'welcome12345',
  'changeme1234', 'password12345', 'iloveyou1234', 'admin1234567', 'qwerty123456', '1q2w3e4r5t6y', 'domus1234567', 'chinorpark123']);

// ≥ 12 characters, not a famous one, not made of one repeated character, not the login (14 §2.1). → null | the reason code.
export function weakPassword(password, login = '') {
  const p = String(password ?? '');
  if (p.length < 12) return 'short';
  if (p.length > 200) return 'long';
  if (COMMON.has(p.toLowerCase()) || /^(.)\1+$/.test(p)) return 'common';
  if (login && p.toLowerCase().includes(String(login).toLowerCase())) return 'login';
  return null;
}

// Staff rows are changed only here; every change that must end the open sessions bumps session_version.
export async function createStaff(q, { login, name, role, passwordHash, lang = 'ru' }, opts = {}) {
  const ctx = context(opts);
  const l = String(login ?? '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,40}$/.test(l)) throw new DomainError('invalid_input', { fields: ['login'] });
  if (!['manager', 'head'].includes(role)) throw new DomainError('invalid_input', { fields: ['role'] });
  if (!String(name ?? '').trim()) throw new DomainError('invalid_input', { fields: ['name'] });
  return q.one(`INSERT INTO staff (login, name, role, password_hash, lang, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [l, String(name).trim().slice(0, 100), role, passwordHash, lang, ctx.now()]);
}

export const staffById = (q, id) => q.one('SELECT * FROM staff WHERE id = $1', [id]);
export const staffByLogin = (q, login) => q.one('SELECT * FROM staff WHERE login = $1', [String(login ?? '').trim().toLowerCase()]);
export const listStaff = q => q.query('SELECT * FROM staff ORDER BY created_at, login');

export async function touchLogin(q, staffId, opts = {}) {
  await q.query('UPDATE staff SET last_login_at = $2 WHERE id = $1', [staffId, context(opts).now()]);
}

// A new password also ends every open session of the person.
export const setPassword = (q, staffId, passwordHash) =>
  q.one('UPDATE staff SET password_hash = $2, session_version = session_version + 1 WHERE id = $1 RETURNING *', [staffId, passwordHash]);

export const logoutEverywhere = (q, staffId) =>
  q.one('UPDATE staff SET session_version = session_version + 1 WHERE id = $1 RETURNING *', [staffId]);

export const setActive = (q, staffId, active) =>
  q.one('UPDATE staff SET active = $2, session_version = session_version + 1 WHERE id = $1 RETURNING *', [staffId, Boolean(active)]);

export const setRole = (q, staffId, role) => {
  if (!['manager', 'head'].includes(role)) throw new DomainError('invalid_input', { fields: ['role'] });
  return q.one('UPDATE staff SET role = $2, session_version = session_version + 1 WHERE id = $1 RETURNING *', [staffId, role]);
};
