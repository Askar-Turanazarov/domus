// Confirmation of the mutating tools (08 §6, 07 §8, D-10): the model only drafts; a person says «Да» and the code executes
// the draft row as it was saved — the model cannot change the arguments afterwards.
//
//   draft(q, {tool, args, preview, ctx})        → the pending_actions row (+ confirmToken for MCP)
//   claim(q, row, ctx)                          → the row now 'executing' | a DomainError: confirm_used / confirm_expired
//   finish(q, id, {ok, result, error}, ctx)
//   canonical(args), sameActor(a, b), tokenHash(token)
import crypto from 'node:crypto';
import { DomainError } from '../core/errors.js';

export const TTL_MS = 10 * 60e3;

// Keys sorted at every level: the same arguments give the same hash whatever their order.
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

export const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
export const argsHash = args => sha256(canonical(args));
export const tokenHash = token => sha256(String(token));

// The same person: type, id and role (the MCP head token has no id — the role decides).
export const sameActor = (a, b) => Boolean(a && b) && a.type === b.type && (a.id ?? null) === (b.id ?? null) && a.role === b.role;

// 08 §6.1 step 2. A new draft of the same tool in the dialog cancels the old one (07 §8.1).
export async function draft(q, { tool, args, preview, ctx }) {
  const at = ctx.now();
  const conversationId = ctx.conversationId ?? null;
  if (conversationId) {
    await q.query(`UPDATE pending_actions SET status = 'cancelled', decided_at = $3
      WHERE conversation_id = $1 AND tool = $2 AND status = 'pending'`, [conversationId, tool, at]);
  }
  const confirmToken = ctx.source === 'mcp' ? 'pa_' + crypto.randomBytes(32).toString('base64url') : null;
  const row = await q.one(`INSERT INTO pending_actions (tool, args, args_hash, preview, source, actor, conversation_id, client_id,
      confirm_token_hash, status, expires_at, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11) RETURNING *`,
  [tool, JSON.stringify(args), argsHash(args), JSON.stringify(preview), ctx.source, JSON.stringify(ctx.actor), conversationId,
    ctx.actor?.role === 'client' ? ctx.actor.id ?? null : null, confirmToken ? tokenHash(confirmToken) : null,
    new Date(at.getTime() + TTL_MS), at]);
  return { row, confirmToken };
}

// 08 §6.1 step 3: only a pending, unexpired row moves to executing — a second «Да» finds nothing.
export async function claim(q, row, ctx) {
  const at = ctx.now();
  if (row.status === 'executed' || row.status === 'executing' || row.status === 'failed') {
    throw new DomainError('confirm_used', { result: row.result, status: row.status });
  }
  if (row.status === 'cancelled') throw new DomainError('pending_not_found');
  if (row.status === 'expired' || row.expires_at <= at) {
    if (row.status === 'pending') await q.query(`UPDATE pending_actions SET status = 'expired', decided_at = $2 WHERE id = $1 AND status = 'pending'`, [row.id, at]);
    throw new DomainError('confirm_expired', { tool: row.tool });
  }
  const got = await q.one(`UPDATE pending_actions SET status = 'executing', decided_at = $2
    WHERE id = $1 AND status = 'pending' AND expires_at > $2 RETURNING *`, [row.id, at]);
  if (!got) {
    const now = await q.one('SELECT status, result FROM pending_actions WHERE id = $1', [row.id]);
    throw new DomainError('confirm_used', { result: now?.result ?? null, status: now?.status });
  }
  return got;
}

export async function finish(q, id, { ok, result = null, error = null }) {
  await q.query(`UPDATE pending_actions SET status = $2, result = $3 WHERE id = $1`,
    [id, ok ? 'executed' : 'failed', JSON.stringify(ok ? result : { error })]);
}
