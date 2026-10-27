// Admin clients (12 §5, 13 §9.3) and the Telegram link of the signed-in staff member (12 §12.3, 13 §9): the list with filters, the
// card, the full phone on request (a journal entry), taking a client, the feed of a dialog. Mounted after mountAdmin, so the staff gate
// is already in front; the core checks the role again.
import { DomainError } from '../core/errors.js';
import { clientsList, clientCard, dialogFeed, revealPhone } from '../core/adminClients.js';
import { assignClient } from '../core/clients.js';
import { issueStaffLinkCode, detachStaffTelegram } from '../core/staff.js';
import { now as clockNow } from '../core/clock.js';
import { handler, parseBody, z, tz, limit, HOUR } from './common.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const flag = v => v === '1' || v === 'true';

export function mountAdminClients(app, db, staffAuth, opts = {}) {
  const env = opts.env ?? process.env;
  const ctx = { ...opts, env, now: opts.now ?? clockNow };
  const at = () => tz(ctx.now());
  const str = v => (typeof v === 'string' && v !== '' ? v : undefined);

  app.get('/api/admin/clients', handler(async (req, res) => {
    const { score, mine, waiting, active, q, cursor, limit: n } = req.query;
    res.json({ ...await clientsList(db, { score: str(score), mine: flag(mine), waiting: flag(waiting), active: flag(active), q: str(q),
      cursor: str(cursor), limit: str(n) }, req.actor, ctx), at: at() });
  }));

  app.get('/api/admin/clients/:id', handler(async (req, res) => {
    const card = await clientCard(db, req.params.id, req.actor, ctx);
    if (!card) throw new DomainError('not_found');
    res.json({ ...card, at: at() });
  }));

  app.post('/api/admin/clients/:id/reveal-phone', handler(async (req, res) => {
    parseBody({}, req.body);
    res.json(await revealPhone(db, req.params.id, req.actor, ctx));
  }));

  // 03 §9, BR-20: a free client is taken by the first one; a client already taken stays with the one who took him.
  app.post('/api/admin/clients/:id/assign', handler(async (req, res) => {
    const body = parseBody({ staffId: z.union([z.literal('me'), z.string().regex(UUID)]) }, req.body);
    if (!UUID.test(req.params.id)) throw new DomainError('not_found');
    const staffId = body.staffId === 'me' ? req.actor.id : body.staffId;
    const out = await assignClient(db, { clientId: req.params.id, staffId }, ctx);
    const card = await clientCard(db, req.params.id, req.actor, ctx);
    res.json({ client: card.client, taken: out.taken });
  }));

  app.get('/api/admin/conversations/:id', handler(async (req, res) => {
    const feed = await dialogFeed(db, req.params.id, { after: str(req.query.after) }, req.actor, ctx);
    if (!feed) throw new DomainError('conversation_not_found');
    res.json({ ...feed, at: at() });
  }));

  // 12 §12.3: a one-time code for 15 minutes in a t.me link; the bot answers «you are linked» (10 §4.1).
  app.post('/api/admin/me/telegram-link', handler(async (req, res) => {
    parseBody({}, req.body);
    const bot = String(env.TELEGRAM_BOT_USERNAME ?? '').replace(/^@/, '');
    if (!bot || !env.TELEGRAM_BOT_TOKEN) throw new DomainError('feature_disabled');
    await limit(db, `tglink:staff:${req.actor.id}`, 5, HOUR, ctx);
    const { code, expiresAt } = await db.tx(q => issueStaffLinkCode(q, { staffId: req.actor.id }, ctx));
    res.json({ url: `https://t.me/${bot}?start=st_${code}`, expiresAt });
  }));

  app.delete('/api/admin/me/telegram', handler(async (req, res) => {
    await detachStaffTelegram(db, { staffId: req.actor.id }, ctx);
    res.status(204).end();
  }));
}
