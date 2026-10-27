// HTTP entries of the site chat (13 §6, 11 §5): the turn as a stream of events (SSE), the answer to a draft, the opinion
// on an answer, the dialog's messages. The turn itself is agents/turn.js; here are the cookie, the owner, the stream.
import { DomainError } from '../core/errors.js';
import { anonymousClient, canonical, leaveContact } from '../core/clients.js';
import { context } from '../core/tx.js';
import { answerDraft } from '../agents/confirm.js';
import { template, menu } from '../agents/scripted.js';
import { t } from '../i18n/index.js';
import { jsonBody, parseBody, z, langOf, idempotencyKey, limit, ipKey, readDcl, setDcl, sendError, tz, STATUS, HOUR } from './common.js';

const LANGS = ['ru', 'uz', 'en'];
const PING_MS = 15_000;                    // 13 §6.1: a comment every 15 s keeps the proxy from closing the stream
const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

// One event of the turn's sink (07 §11.2) → its SSE name and data (11 §5.2).
export function frame(ev) {
  const data = ev.type === 'text' ? { agent: ev.agent, delta: ev.delta } : ev.type === 'reset' ? { agent: ev.agent } : ev.data;
  return `event: ${ev.type}\ndata: ${JSON.stringify(data ?? {})}\n\n`;
}

// deps — { turns (createTurns), tools (createTools) }; opts — { env, onCommit, render } for the core.
export function mountChat(app, db, { turns, tools }, opts = {}) {
  const env = opts.env ?? process.env;
  const ctxOf = () => context(opts);
  app.use('/api/chat', jsonBody);

  // The client of the cookie, or a new anonymous card (the cookie is set before the first byte).
  async function visitor(req, res, lang) {
    const dcl = readDcl(req, env);
    const known = dcl ? await canonical(db, dcl) : null;
    if (known) return known;
    const fresh = await anonymousClient(db, { lang }, opts);
    setDcl(res, req, fresh.id, env);
    return fresh;
  }

  // 13 §6.2: the owner is the client of the cookie; anything else is «not found» — we do not say the dialog exists.
  async function owned(req, id) {
    const dcl = readDcl(req, env);
    const client = dcl ? await canonical(db, dcl) : null;
    const conv = client && UUID.safeParse(id).success ? await db.one('SELECT * FROM conversations WHERE id = $1', [id]) : null;
    if (!conv || conv.kind !== 'client' || conv.client_id !== client.id) throw new DomainError('conversation_not_found');
    return { conv, client };
  }

  const actorOf = client => ({ type: 'client', id: client.id, role: 'client', channel: 'web' });

  // ---- POST /api/chat (13 §6.1) ----
  app.post('/api/chat', async (req, res) => {
    res.set({ 'Referrer-Policy': 'no-referrer' });
    const lang = langOf(req);
    let streaming = false;
    let ping = null;
    try {
      const body = parseBody({
        conversationId: UUID.optional(),
        text: z.string().max(2000).optional(),
        intent: z.string().regex(/^[a-z_]{1,40}$/).optional(),
        payload: z.record(z.string(), z.unknown()).optional(),
        context: z.strictObject({ apartmentNo: z.number().int().min(1).max(100000).optional(), page: z.enum(['building', 'planner', 'booking']) }).optional(),
        lang: z.enum(LANGS).optional()
      }, req.body);
      if ((body.text == null) === (body.intent == null)) throw new DomainError('invalid_input', { fields: ['text', 'intent'] });
      const ctx = ctxOf();
      await limit(db, `chat:ip:${ipKey(req, env)}:open`, 120, 60e3, ctx);

      const client = await visitor(req, res, body.lang ?? lang);
      let conv;
      let fresh = false;
      if (body.conversationId) ({ conv } = await owned(req, body.conversationId));
      else {
        const at = ctx.now();
        conv = await db.one(`INSERT INTO conversations (kind, client_id, channel, lang, created_at, updated_at)
          VALUES ('client', $1, 'web', $2, $3, $3) RETURNING *`, [client.id, body.lang ?? lang, at]);
        fresh = true;
      }
      if (conv.turn_lock_until && new Date(conv.turn_lock_until) > ctx.now()) throw new DomainError('turn_in_progress');

      // The page's context: the apartment on the screen is the focus of the dialog (07 §6.1); the phone of the form stays in the memory.
      const state = { ...(conv.state ?? {}) };
      if (body.context?.apartmentNo != null) state.focusApartment = body.context.apartmentNo;
      let intent = body.intent ?? null;
      let payload = body.payload ?? {};
      let saidPhone = false;
      if ((intent === 'leave_phone' || intent === 'call_manager') && payload.phone != null) {
        const r = await leaveContact(db, { clientId: client.id, name: payload.name ?? null, phone: payload.phone }, opts);
        state.contactPhone = r.phone;
        state.contactPhoneVerified = false;
        saidPhone = intent === 'leave_phone';
        payload = {};
      }
      await db.query('UPDATE conversations SET state = $2, updated_at = $3 WHERE id = $1', [conv.id, JSON.stringify(state), ctx.now()]);

      // The stream: headers at once, the first status in the first second (PERF-03), then the turn.
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

      if (saidPhone) {
        const tpl = template('phone_saved', conv.lang);
        send({ type: 'text', agent: 'scripted', delta: tpl.text });
        send({ type: 'suggestions', data: menu(conv.lang, { channel: 'web' }).suggestions.slice(0, 3) });
        send({ type: 'done', data: { turnId: null, messageId: null } });
      } else {
        const out = await turns.runTurn({ conversationId: conv.id, text: body.text ?? '', intent, payload, actor: actorOf(client),
          channel: 'web', sink: send, ip: ipKey(req, env) });
        // the lock was taken between our check and the turn: the message is stored, the running turn answers it
        if (out?.status === 'queued') send({ type: 'error', data: { code: 'turn_in_progress', text: t(conv.lang, 'err.turn_in_progress') } });
      }
    } catch (e) {
      if (!streaming) return sendError(res, e, lang);
      console.error('chat turn failed:', e?.message);
      res.write(frame({ type: 'error', data: { code: 'ai_unavailable', text: t(lang, 'err.ai_unavailable') } }));
    } finally {
      clearInterval(ping);
      if (streaming) res.end();
    }
  });

  // ---- POST /api/chat/confirm (13 §6.2, 07 §8): «Да» / «Изменить» / «Отмена» / «Повторить» on the card ----
  app.post('/api/chat/confirm', async (req, res) => {
    res.set({ 'Referrer-Policy': 'no-referrer' });
    const lang = langOf(req);
    try {
      const body = parseBody({ pendingActionId: UUID, answer: z.enum(['yes', 'no', 'edit', 'retry']), lang: z.enum(LANGS).optional() }, req.body);
      idempotencyKey(req);
      const dcl = readDcl(req, env);
      const client = dcl ? await canonical(db, dcl) : null;
      const row = client ? await db.one('SELECT id, conversation_id, client_id FROM pending_actions WHERE id = $1', [body.pendingActionId]) : null;
      if (!row) throw new DomainError('pending_not_found');
      if (row.client_id !== client.id) throw new DomainError('confirm_mismatch');
      const conv = row.conversation_id ? await db.one('SELECT lang, state FROM conversations WHERE id = $1', [row.conversation_id]) : null;
      const r = await answerDraft(tools, { pendingActionId: body.pendingActionId, answer: body.answer === 'no' ? 'cancel' : body.answer },
        { actor: actorOf(client), source: 'agent', lang: body.lang ?? conv?.lang ?? lang, conversationId: row.conversation_id,
          contactPhone: conv?.state?.contactPhone ?? null, onCommit: opts.onCommit, render: opts.render }, env);
      const requestId = res.get('X-Request-Id');
      if (['executed', 'cancelled', 'pending'].includes(r.status)) {
        const { status, text, blocks, suggestions, result, pendingActionId } = r;
        return res.json({ status, text, blocks, suggestions, ...(result ? { result } : {}), ...(pendingActionId ? { pendingActionId } : {}), requestId });
      }
      // expired / failed / error: the code of 13 §2 with the text the client reads
      const status = r.status === 'failed' ? (STATUS[r.error] ?? 409) : (STATUS[r.error] ?? 400);
      return res.status(status).json({ error: r.error, message: r.text, status: r.status, suggestions: r.suggestions ?? [], requestId });
    } catch (e) {
      sendError(res, e, lang);
    }
  });

  // ---- POST /api/chat/feedback (13 §6.2, 07 §16.3) ----
  app.post('/api/chat/feedback', async (req, res) => {
    const lang = langOf(req);
    try {
      const body = parseBody({ messageId: z.number().int().positive(), value: z.union([z.literal(1), z.literal(-1)]),
        note: z.string().max(300).optional(), lang: z.enum(LANGS).optional() }, req.body);
      const dcl = readDcl(req, env);
      const client = dcl ? await canonical(db, dcl) : null;
      const m = client && await db.one(`SELECT m.id, c.client_id FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE m.id = $1 AND m.role = 'assistant'`, [body.messageId]);
      if (!m || m.client_id !== client.id) throw new DomainError('conversation_not_found');
      await limit(db, `chat:feedback:${client.id}`, 60, HOUR, ctxOf());
      await db.query('UPDATE messages SET feedback = $2, feedback_note = $3 WHERE id = $1', [m.id, body.value, body.note ?? null]);
      res.status(204).end();
    } catch (e) {
      sendError(res, e, lang);
    }
  });

  // ---- GET /api/chat/:conversationId/messages?after= (13 §6.2, 11 §5.6): what the manager wrote while the widget was closed ----
  app.get('/api/chat/:conversationId/messages', async (req, res) => {
    const lang = langOf(req);
    try {
      const { conv } = await owned(req, req.params.conversationId);
      const after = /^\d{1,15}$/.test(String(req.query.after ?? '')) ? Number(req.query.after) : 0;
      const rows = await db.query(`SELECT id, role, text, blocks, created_at FROM messages
        WHERE conversation_id = $1 AND id > $2 AND role <> 'note' ORDER BY id LIMIT 100`, [conv.id, after]);
      res.json({ items: rows.map(m => ({ id: m.id, role: m.role, text: m.text, blocks: m.blocks ?? [], at: tz(m.created_at) })), mode: conv.mode });
    } catch (e) {
      sendError(res, e, lang);
    }
  });
}
