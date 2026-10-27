// Admin board entries (12 §3, 13 §9.2): all apartments for the chessboard and the apartment card. Mounted after mountAdmin,
// so the staff gate is already in front. Changes (hold for a client, sale, shift) come with D4-03.
import { DomainError } from '../core/errors.js';
import { unitsBoard, apartmentCard } from '../core/adminViews.js';
import { now as clockNow } from '../core/clock.js';
import { handler, tz } from './common.js';

export function mountAdminBoard(app, db, opts = {}) {
  const ctx = { now: opts.now ?? clockNow };

  app.get('/api/admin/units', handler(async (req, res) => {
    res.json({ units: await unitsBoard(db, req.actor, ctx), at: tz(ctx.now()) });
  }));

  app.get('/api/admin/apartments/:no', handler(async (req, res) => {
    const no = Number(req.params.no);
    if (!Number.isInteger(no) || no < 1 || no > 9999) throw new DomainError('apartment_not_found', { no: req.params.no });
    const card = await apartmentCard(db, no, req.actor, ctx);
    if (!card) throw new DomainError('apartment_not_found', { no });
    res.json({ ...card, at: tz(ctx.now()) });
  }));
}
