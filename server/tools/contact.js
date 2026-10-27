// The client's contact for create_booking / book_viewing (07 §5.3): in Telegram the account is enough; on the site and in
// the mini app — a phone (the dialog memory state.contactPhone, else the card). No phone there → need_phone. A viewing
// always needs a phone (03 §12): required.
import { DomainError } from '../core/errors.js';
import { normalizePhone } from '../core/phone.js';

const NEEDS_PHONE = ['web', 'mini'];

export async function contactOf(ctx, { phone: given = null, name = null, required = false } = {}) {
  if (!ctx.actor?.id) throw new DomainError('need_phone');
  const c = await ctx.db.one('SELECT id, name, phone, telegram_user_id FROM clients WHERE id = $1', [ctx.actor.id]);
  if (!c) throw new DomainError('invalid_input');
  if (given != null && !normalizePhone(given)) throw new DomainError('phone_invalid');
  const phone = normalizePhone(given) ?? normalizePhone(ctx.contactPhone) ?? c.phone ?? null;
  if (!phone && (required || NEEDS_PHONE.includes(ctx.actor.channel) || ctx.source === 'mcp')) throw new DomainError('need_phone');
  return { client: c, phone, name: name ?? c.name ?? null };
}
