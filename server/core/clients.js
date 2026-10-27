// Clients (03 §9, D-06): one person — one card, but a phone typed by hand never hands over someone else's card.
// Merge happens only on proof: a Telegram contact shared by its owner (R2) or a one-time link code (R6).
import crypto from 'node:crypto';
import { DomainError } from './errors.js';
import { emit } from './events.js';
import { normalizePhone } from './phone.js';
import { bookingPath } from './links.js';
import { context, inTx, notify } from './tx.js';

const LINK_DAYS = 7;
const sameName = (a, b) => String(a ?? '').toLowerCase().replace(/\s+/g, '') === String(b ?? '').toLowerCase().replace(/\s+/g, '');
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

export function nameOf(name) {
  const n = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  if (n.length < 2 || n.length > 60) throw new DomainError('name_invalid');
  return n;
}

export function phoneOf(phone) {
  const p = normalizePhone(phone);
  if (!p) throw new DomainError('phone_invalid');
  return p;
}

// The live card: follow merged_into (a merged card points at the one that absorbed it).
export async function canonical(q, id) {
  let c = await q.one('SELECT * FROM clients WHERE id = $1', [id]);
  for (let i = 0; c?.merged_into && i < 10; i++) c = await q.one('SELECT * FROM clients WHERE id = $1', [c.merged_into]);
  return c;
}

async function create(q, fields, channel, actor, ctx) {
  const at = ctx.now();
  const c = await q.one(`INSERT INTO clients (name, phone, telegram_user_id, telegram_username, telegram_chat_id, lang, channels,
      first_channel, possible_duplicate_of, created_at, updated_at, last_seen_at)
    VALUES ($1, $2, $3, $4, $5, $6, ARRAY[$7], $7, $8, $9, $9, $9) RETURNING *`,
    [fields.name ?? null, fields.phone ?? null, fields.tg?.userId ?? null, fields.tg?.username ?? null, fields.tg?.chatId ?? null,
      fields.lang ?? 'ru', channel, fields.duplicateOf ?? null, at]);
  await emit(q, 'client.created', { clientId: c.id }, { channel }, actor, ctx);
  return c;
}

// The card was seen again: add the channel; a Telegram visit refreshes username and chat.
const touch = (q, c, channel, at, tg = {}) => q.one(
  `UPDATE clients SET channels = CASE WHEN $2 = ANY(channels) THEN channels ELSE array_append(channels, $2) END,
     last_seen_at = $3, updated_at = $3, telegram_username = COALESCE($4, telegram_username),
     telegram_chat_id = COALESCE($5, telegram_chat_id) WHERE id = $1 RETURNING *`,
  [c.id, channel, at, tg.username ?? null, tg.chatId ?? null]);

// Tables whose client_id moves to the winner on merge (03 §9.2); events and outbox keep history as it was.
const MOVE = ['bookings', 'payments', 'viewings', 'orders', 'conversations', 'client_link_codes', 'pending_actions']
  .map(t => `UPDATE ${t} SET client_id = $2 WHERE client_id = $1`);

// Who is this (03 §9.1) → the client card. Inside the caller's transaction.
// who — { id? (a known card), cookieId? (signed dcl, R5), name?, phone?, telegram?: {userId, username?, chatId?}, lang? }.
export async function resolveClient(q, who, channel, actor = { type: 'system' }, opts = {}) {
  const ctx = context(opts);
  const at = ctx.now();
  if (who.id) {
    const c = await canonical(q, who.id);
    if (!c) throw new DomainError('invalid_input');
    return touch(q, c, channel, at);
  }
  if (who.telegram?.userId) {                                                              // R1
    const tg = who.telegram;
    const c = await q.one('SELECT * FROM clients WHERE telegram_user_id = $1', [tg.userId]);
    if (!c) return create(q, { name: who.name, tg, lang: who.lang }, channel, actor, ctx);
    return touch(q, c, channel, at, tg);
  }
  const name = nameOf(who.name);
  const phone = phoneOf(who.phone);
  if (who.cookieId) {                                                                       // R5
    const c = await canonical(q, who.cookieId);
    if (c && c.phone === phone) return touch(q, c, channel, at);
  }
  const owner = await q.one('SELECT * FROM clients WHERE phone = $1 AND phone_verified AND merged_into IS NULL', [phone]);
  const loose = await q.query(`SELECT * FROM clients WHERE phone = $1 AND NOT phone_verified AND merged_into IS NULL
    ORDER BY created_at`, [phone]);
  const same = loose.find(c => sameName(c.name, name));                                     // R4
  if (same) return touch(q, same, channel, at);
  // R3: verified by a Telegram owner → never joined; R4: same number, other name → a new card with a hint.
  const hint = owner?.id ?? loose[0]?.id ?? null;
  return create(q, { name, phone, lang: who.lang, duplicateOf: hint }, channel, actor, ctx);
}

// merge(loser → winner) (03 §9.2), inside the caller's transaction.
export async function merge(q, loserId, winnerId, rule, actor = { type: 'system' }, opts = {}) {
  const ctx = context(opts);
  if (loserId === winnerId) return;
  const [a, b] = [loserId, winnerId].sort();
  await q.query('SELECT id FROM clients WHERE id = $1 FOR UPDATE', [a]);
  await q.query('SELECT id FROM clients WHERE id = $1 FOR UPDATE', [b]);
  const loser = await q.one('SELECT * FROM clients WHERE id = $1', [loserId]);
  const winner = await q.one('SELECT * FROM clients WHERE id = $1', [winnerId]);
  for (const sql of MOVE) await q.query(sql, [loserId, winnerId]);
  const at = ctx.now();
  const fresher = (loser.lead_scored_at ?? 0) > (winner.lead_scored_at ?? 0);
  await q.query(`UPDATE clients SET merged_into = $2, telegram_user_id = NULL, phone_verified = false, updated_at = $3 WHERE id = $1`,
    [loserId, winnerId, at]);
  await q.query(`UPDATE clients SET
      name = COALESCE(NULLIF(name, ''), $2),
      channels = ARRAY(SELECT DISTINCT unnest(channels || $3::text[])),
      assigned_staff_id = COALESCE(assigned_staff_id, $4), assigned_at = COALESCE(assigned_at, $5),
      lead_score = CASE WHEN $6 THEN $7 ELSE lead_score END, lead_summary = CASE WHEN $6 THEN $8 ELSE lead_summary END,
      lead_next_step = CASE WHEN $6 THEN $9 ELSE lead_next_step END, lead_scored_at = CASE WHEN $6 THEN $10 ELSE lead_scored_at END,
      updated_at = $11
    WHERE id = $1`,
  [winnerId, loser.name, loser.channels, loser.assigned_staff_id, loser.assigned_at, fresher, loser.lead_score, loser.lead_summary,
    loser.lead_next_step, loser.lead_scored_at, at]);
  await emit(q, 'client.merged', { clientId: winnerId }, { from: loserId, to: winnerId, rule }, actor, ctx);
}

// R2: a Telegram client shared their own contact (the caller checked contact.user_id === from.id).
// → { client, conflict }. A number verified by another Telegram is not taken: a hint and client.merge_conflict.
export async function verifyPhone(db, { clientId, phone }, actor = { type: 'system' }, opts = {}) {
  const ctx = context(opts);
  const p = phoneOf(phone);
  return inTx(db, ctx, async q => {
    const me = await canonical(q, clientId);
    if (!me) throw new DomainError('invalid_input');
    const other = await q.one('SELECT * FROM clients WHERE phone = $1 AND phone_verified AND merged_into IS NULL AND id <> $2 FOR UPDATE',
      [p, me.id]);
    const at = ctx.now();
    if (other) {
      const c = await q.one('UPDATE clients SET possible_duplicate_of = $2, updated_at = $3 WHERE id = $1 RETURNING *', [me.id, other.id, at]);
      await emit(q, 'client.merge_conflict', { clientId: me.id }, { other: other.id }, actor, ctx);
      return { client: c, conflict: true };
    }
    await q.query('UPDATE clients SET phone = $2, phone_verified = true, updated_at = $3 WHERE id = $1', [me.id, p, at]);
    await emit(q, 'client.phone_verified', { clientId: me.id }, {}, actor, ctx);
    const strays = await q.query(`SELECT id FROM clients WHERE phone = $1 AND telegram_user_id IS NULL AND merged_into IS NULL AND id <> $2`,
      [p, me.id]);
    for (const s of strays) await merge(q, s.id, me.id, 'R2', actor, ctx);
    return { client: await q.one('SELECT * FROM clients WHERE id = $1', [me.id]), conflict: false };
  });
}

// A one-time code for t.me/<bot>?start=lk_<code> (R6, 14 §3.2): 16 random bytes, only the sha256 is stored, 7 days.
export async function issueLinkCode(q, { clientId, bookingId = null }, opts = {}) {
  const ctx = context(opts);
  const code = crypto.randomBytes(16).toString('base64url');
  await q.query('INSERT INTO client_link_codes (code_hash, client_id, booking_id, expires_at) VALUES ($1, $2, $3, $4)',
    [sha256(code), clientId, bookingId, new Date(ctx.now().getTime() + LINK_DAYS * 864e5)]);
  return code;
}

// /start lk_<code> (R6): the site card joins the Telegram card, or gets its Telegram if there is no such card yet.
// telegram — { userId, username?, chatId?, lang? }. → { client, bookingId }.
export async function attachTelegram(db, { code, telegram }, opts = {}) {
  const ctx = context(opts);
  const actor = { type: 'client', id: null, role: 'client', channel: 'telegram' };
  return inTx(db, ctx, async (q, fx) => {
    const at = ctx.now();
    const link = await q.one('SELECT * FROM client_link_codes WHERE code_hash = $1 FOR UPDATE', [sha256(String(code ?? ''))]);
    if (!link || link.used_at || link.expires_at <= at) throw new DomainError('link_invalid');
    const site = await canonical(q, link.client_id);
    const tgCard = await q.one('SELECT * FROM clients WHERE telegram_user_id = $1', [telegram.userId]);
    let client;
    if (tgCard && tgCard.id !== site.id) {
      if (site.telegram_user_id) throw new DomainError('telegram_linked_elsewhere');
      await merge(q, site.id, tgCard.id, 'R6', actor, ctx);
      client = await q.one('UPDATE clients SET telegram_chat_id = COALESCE($2, telegram_chat_id), updated_at = $3 WHERE id = $1 RETURNING *',
        [tgCard.id, telegram.chatId ?? null, at]);
    } else if (site.telegram_user_id && site.telegram_user_id !== telegram.userId) {
      throw new DomainError('telegram_linked_elsewhere');
    } else {
      client = await q.one(`UPDATE clients SET telegram_user_id = $2, telegram_username = $3, telegram_chat_id = COALESCE($4, telegram_chat_id),
          channels = CASE WHEN 'telegram' = ANY(channels) THEN channels ELSE array_append(channels, 'telegram') END, updated_at = $5
        WHERE id = $1 RETURNING *`, [site.id, telegram.userId, telegram.username ?? null, telegram.chatId ?? null, at]);
    }
    await q.query('UPDATE client_link_codes SET used_at = $2 WHERE code_hash = $1', [link.code_hash, at]);
    await emit(q, 'client.telegram_linked', { clientId: client.id, bookingId: link.booking_id }, { rule: 'R6' }, { ...actor, id: client.id }, ctx);
    if (link.booking_id) {
      const b = await q.one('SELECT id, no, access_version FROM bookings WHERE id = $1', [link.booking_id]);
      await notify(q, fx, ctx, { template: 'link_telegram_done', audience: 'client', clientId: client.id, vars: { bookingNo: b.no, link: bookingPath(b, ctx.env) },
        dedupeKey: `link_telegram_done:${link.code_hash}` });
    }
    return { client, bookingId: link.booking_id };
  });
}

// The client wrote to the bot, so it is not blocked any more (10 §9).
export async function unblockTelegram(q, clientId) {
  await q.query('UPDATE clients SET tg_blocked_at = NULL WHERE id = $1', [clientId]);
}

// The language chosen in the bot: the card and the open dialogue follow it (10 §4.1).
export async function setLang(q, clientId, lang) {
  await q.query('UPDATE conversations SET lang = $2 WHERE client_id = $1', [clientId, lang]);
  return q.one('UPDATE clients SET lang = $2 WHERE id = $1 RETURNING *', [clientId, lang]);
}
