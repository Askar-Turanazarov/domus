// The head's analyst over HTTP (13 §9: POST /api/admin/analyst, 12 §11, 07 §14): «как POST /api/chat (без intent)» — the same SSE
// protocol, a dialog of kind 'analyst' owned by this staff member. The head only; the agent's tools only read (08 §3, D-25).
import { DomainError } from '../core/errors.js';
import { context } from '../core/tx.js';
import { t } from '../i18n/index.js';
import { frame } from './chat.js';
import { parseBody, z, langOf, limit, sendError } from './common.js';

const LANGS = ['ru', 'uz', 'en'];
const PING_MS = 15_000;
const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

// deps — { turns (createTurns) }; opts — the core options.
export function mountAdminAnalyst(app, db, staffAuth, { turns }, opts = {}) {
  const head = staffAuth.gate('head');

  app.post('/api/admin/analyst', head, async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const lang = langOf(req);
    let streaming = false;
    let ping = null;
    try {
      const body = parseBody({ conversationId: UUID.optional(), text: z.string().trim().min(1).max(2000), lang: z.enum(LANGS).optional() }, req.body);
      const ctx = context(opts);
      await limit(db, `analyst:staff:${req.staff.id}:open`, 60, 60e3, ctx);
      let conv;
      let fresh = false;
      if (body.conversationId) {
        conv = await db.one('SELECT * FROM conversations WHERE id = $1', [body.conversationId]);
        // another head's dialog is «not found» — we do not say it exists
        if (!conv || conv.kind !== 'analyst' || conv.staff_id !== req.staff.id) throw new DomainError('conversation_not_found');
      } else {
        const at = ctx.now();
        conv = await db.one(`INSERT INTO conversations (kind, staff_id, channel, lang, created_at, updated_at)
          VALUES ('analyst', $1, 'admin', $2, $3, $3) RETURNING *`, [req.staff.id, body.lang ?? req.staff.lang ?? lang, at]);
        fresh = true;
      }
      if (conv.turn_lock_until && new Date(conv.turn_lock_until) > ctx.now()) throw new DomainError('turn_in_progress');

      res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
      res.flushHeaders();
      streaming = true;
      let open = true;
      res.on('close', () => { open = false; clearInterval(ping); });
      const write = s => { if (open) res.write(s); };
      ping = setInterval(() => write(': ping\n\n'), PING_MS);
      const send = ev => write(frame(ev));
      if (fresh) send({ type: 'meta', data: { conversationId: conv.id } });
      send({ type: 'status', data: { text: t(conv.lang, 'agent.status.thinking') } });
      const out = await turns.runAnalyst({ conversationId: conv.id, text: body.text, actor: req.actor, sink: send });
      if (out?.status === 'queued') send({ type: 'error', data: { code: 'turn_in_progress', text: t(conv.lang, 'err.turn_in_progress') } });
    } catch (e) {
      if (!streaming) return sendError(res, e, lang);
      console.error('analyst turn failed:', e?.message);
      res.write(frame({ type: 'error', data: { code: 'ai_unavailable', text: t(lang, 'err.ai_unavailable') } }));
    } finally {
      clearInterval(ping);
      if (streaming) res.end();
    }
  });
}
