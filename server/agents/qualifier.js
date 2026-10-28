// The quiet `fast` tasks of the CRM (07 §13): the lead qualifier (job conversation.qualify, 10 min after the client's last message,
// only when there are new messages since the last score) and «Что ответить?» — a draft for the manager that is never sent by itself.
// The rules of §13.1 are applied by code over the model's answer; without a model the job waits an hour, 3 times, then rules only.
import { z } from 'zod';
import { prompt } from './prompts.js';
import { mask } from './pii.js';
import { setLeadScore } from '../core/clients.js';
import { context, later } from '../core/tx.js';

export const QUALIFY_DELAY_MS = 10 * 60e3;
const RETRY_MS = 3600e3;
const MAX_TRIES = 3;
const LAST = 20;
const HINT_LAST = 6;
const RANK = { cold: 0, warm: 1, hot: 2 };
const GREETING = /^\s*(привет|здравствуйте|добрый\s+(день|вечер|утро)|салам|assalomu\s+alaykum|salom|hello|hi|hey)[\s!.,)]*$/iu;

const QualifyOut = z.strictObject({
  score: z.enum(['hot', 'warm', 'cold']),
  summary: z.string(),
  next_step: z.string()
});
const SCHEMA = z.toJSONSchema(QualifyOut, { target: 'draft-7' });
delete SCHEMA.$schema;

const who = role => (role === 'user' ? 'client' : role === 'staff' ? 'manager' : 'assistant');

// The facts from the core (§13.1 input): a paid booking, a live hold, a viewing, how many apartments were shown.
export async function leadFacts(q, clientId, conversationId) {
  const f = await q.one(`SELECT
      EXISTS (SELECT 1 FROM bookings WHERE client_id = $1 AND status IN ('booked','converted')) AS paid,
      EXISTS (SELECT 1 FROM bookings WHERE client_id = $1 AND status = 'held') AS hold,
      EXISTS (SELECT 1 FROM viewings WHERE client_id = $1 AND status IN ('scheduled','done')) AS viewing`, [clientId]);
  const shown = new Set();
  for (const m of await q.query(`SELECT blocks FROM messages WHERE conversation_id = $1 AND role = 'assistant' AND blocks IS NOT NULL`, [conversationId])) {
    for (const b of m.blocks ?? []) if (b?.type === 'apartments') for (const i of b.data?.items ?? []) shown.add(i.no ?? i.apartmentNo);
  }
  return { paid: f.paid, hold: f.hold, viewing: f.viewing, apartmentsSeen: shown.size };
}

// §13.1: a paid booking → at least hot; a hold or a viewing → at least warm; one «привет» and nothing else → cold.
export function rulesFloor(score, facts, userTexts) {
  let s = score ?? 'cold';
  const atLeast = min => { if (RANK[s] < RANK[min]) s = min; };
  if (facts.paid) atLeast('hot');
  if (facts.hold || facts.viewing) atLeast('warm');
  if (!facts.paid && !facts.hold && !facts.viewing && userTexts.length === 1 && GREETING.test(userTexts[0])) s = 'cold';
  return s;
}

async function dialog(q, conv, n) {
  const rows = await q.query(`SELECT id, role, text FROM messages WHERE conversation_id = $1 AND role IN ('user','assistant','staff')
    ORDER BY id DESC LIMIT ${n}`, [conv.id]);
  return rows.reverse();
}
const lines = (rows, lang) => rows.map(m => `${who(m.role)}: ${mask(m.text, lang).text}`).join('\n');

// What the qualifier sees: the dialog, the facts, the client's first messages. → { conv, client, lastId, rows, facts, userTexts } | { status }
async function look(q, { conversationId, force = false }) {
  const conv = await q.one(`SELECT * FROM conversations WHERE id = $1 AND kind = 'client'`, [conversationId]);
  if (!conv?.client_id) return { status: 'no_client' };
  const client = await q.one('SELECT id, lead_scored_message_id FROM clients WHERE id = $1', [conv.client_id]);
  if (!client) return { status: 'no_client' };
  const last = await q.one(`SELECT max(id) AS id FROM messages WHERE conversation_id = $1 AND role = 'user'`, [conv.id]);
  const lastId = last?.id != null ? Number(last.id) : null;
  if (lastId == null || (!force && client.lead_scored_message_id != null && Number(client.lead_scored_message_id) >= lastId)) {
    return { status: 'nothing_new' };
  }
  const rows = await dialog(q, conv, LAST);
  const facts = await leadFacts(q, client.id, conv.id);
  const userTexts = (await q.query(`SELECT text FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE c.client_id = $1 AND m.role = 'user' ORDER BY m.id LIMIT 2`, [client.id])).map(m => m.text);
  return { conv, client, lastId, rows, facts, userTexts };
}

// The model's answer, checked by the schema → { score, summary, next_step } | null (no model, down, or a bad answer).
async function ask(ai, { conv, rows, facts }, ctx) {
  if (!ai) return null;
  try {
    const res = await ai.chat({ role: 'fast', agent: 'qualifier', system: prompt('qualifier', { common: false }).text, maxOutputTokens: 400,
      output: { schema: SCHEMA }, deadline: ctx.now().getTime() + 20_000,
      messages: [{ role: 'user', parts: [{ type: 'text', text: [conv.summary ? `[summary] ${conv.summary}` : null,
        `[facts] ${JSON.stringify(facts)}`, `[dialog]\n${lines(rows, conv.lang)}`].filter(Boolean).join('\n') }] }] });
    const ok = res.provider !== 'scripted' && res.json ? QualifyOut.safeParse(res.json) : null;
    return ok?.success ? ok.data : null;
  } catch {
    return null;   // the model is down: the same as no answer
  }
}

// One run of the qualifier on the job's transaction q; prepared — { out } asked before the transaction (the job), else asked here.
// → { status: 'scored' | 'nothing_new' | 'deferred' | 'no_client', score? }
export async function qualify(q, ai, payload, opts = {}, fx = { outbox: [], jobs: [] }, prepared = null) {
  const ctx = context(opts);
  const { force = false, attempt = 1 } = payload;
  const l = await look(q, payload);
  if (l.status) return l;
  const { conv, client, lastId, facts, userTexts } = l;
  const out = prepared ? prepared.out : await ask(ai, l, ctx);
  if (!out && attempt < MAX_TRIES) {
    await later(q, fx, ctx, 'conversation.qualify', new Date(ctx.now().getTime() + RETRY_MS), { conversationId: conv.id, force, attempt: attempt + 1 },
      `conversation.qualify:${conv.id}:${lastId}:try${attempt + 1}`);
    return { status: 'deferred' };
  }
  const score = rulesFloor(out?.score, facts, userTexts);
  await setLeadScore(q, { clientId: client.id, score, summary: out ? mask(out.summary, conv.lang).text.slice(0, 300) : null,
    nextStep: out ? mask(out.next_step, conv.lang).text.slice(0, 120) : null, messageId: lastId }, { type: 'system' }, ctx);
  return { status: 'scored', score, byRules: !out };
}

// The job conversation.qualify (04 §6): the qualifier on the job's own transaction.
export function qualifyHandlers(opts = {}, fx = { outbox: [], jobs: [] }) {
  return {
    'conversation.qualify': {
      // the model is asked outside the job's transaction: a slow call must not hold it
      prepare: async (job, { db, now }) => {
        const l = await look(db, job.payload);
        return l.status ? { out: null } : { out: await ask(opts.ai, l, context({ ...opts, now })) };
      },
      run: async (job, { q, now, prepared }) => {
        const r = await qualify(q, opts.ai, job.payload, { ...opts, now }, fx, prepared);
        return r.status === 'scored' || r.status === 'deferred' ? 'done' : 'skipped';
      }
    }
  };
}

// Each message of the client moves the job to «last message + 10 min» (04 §6): the older scheduled one is cancelled.
export async function scheduleQualify(q, { conversationId, messageId }, opts = {}) {
  const ctx = context(opts);
  await q.query(`UPDATE jobs SET status = 'cancelled', updated_at = $2 WHERE status = 'scheduled' AND type = 'conversation.qualify'
    AND payload->>'conversationId' = $1`, [conversationId, ctx.now()]);
  const fx = { outbox: [], jobs: [] };
  await later(q, fx, ctx, 'conversation.qualify', new Date(ctx.now().getTime() + QUALIFY_DELAY_MS), { conversationId },
    `conversation.qualify:${conversationId}:${messageId}`);
  return fx.jobs;
}

// «Что ответить?» (07 §13.2): the summary and the last 6 messages → a draft for the manager. → { draft } | null (no model)
export async function suggestReply(q, ai, conversationId, opts = {}) {
  const ctx = context(opts);
  const conv = await q.one(`SELECT * FROM conversations WHERE id = $1 AND kind = 'client'`, [conversationId]);
  if (!conv) return null;
  if (!ai) return { draft: null };
  const rows = await dialog(q, conv, HINT_LAST);
  const res = await ai.chat({ role: 'fast', agent: 'reply_hint', system: prompt('reply_hint', { common: false }).text, maxOutputTokens: 400,
    deadline: ctx.now().getTime() + 20_000,
    messages: [{ role: 'user', parts: [{ type: 'text', text: [conv.summary ? `[summary] ${conv.summary}` : null, `[language] ${conv.lang}`,
      `[dialog]\n${lines(rows, conv.lang)}`].filter(Boolean).join('\n') }] }] });
  if (res.provider === 'scripted') return { draft: null };
  const draft = res.parts.filter(p => p.type === 'text').map(p => p.text).join('').trim().slice(0, 2000);
  return { draft: draft || null };
}
