// A whole turn (07 §6, §9–12, §16): limits → the turn lock → the client's message → a short path or the router → the agents
// in order with the stream of §11.2 → one assistant message with blocks and buttons → the memory → agent_runs → unlock.
// A message that came while a turn ran waits in `messages`; the running turn answers it right after (up to 2 in a row).
import { randomUUID } from 'node:crypto';
import { now as clockNow } from '../core/clock.js';
import { settingsOf } from '../core/bookings.js';
import { t } from '../i18n/index.js';
import { aptUrl } from '../tools/common.js';
import { route, shortcut } from './router.js';
import { runAgent, smalltalk } from './agent.js';
import { contextBlock, digestOf, memoryLine, analystContext } from './context.js';
import { analystTable } from './analystTable.js';
import { scheduleQualify } from './qualifier.js';
import { clientWroteToHuman } from '../core/dialogs.js';
import { publishJobs } from '../events/runner.js';
import { mask, forStorage } from './pii.js';
import { confirmCard, textConsent } from './confirm.js';
import { bookingCard } from './bookingCard.js';
import { menu, template, statusText, fallbackSuggestions } from './scripted.js';

export const TURN_MS = 45_000;            // §10: the turn's budget
const LOCK_MS = 50_000;                   // §11.1 step 2
const MAX_TEXT = 2000;                    // §10
const HISTORY = 12;                       // §6.2
const MODEL_AGENTS = new Set(['apt_finder', 'finance', 'booking', 'kb_consultant']);
const BOT = /(?:\bбот\b|\bробот|\bbot\b|\brobot|сунъий|sun[ʼ'‘]?iy)/iu;

const usage0 = { input: 0, output: 0, cached: 0 };

// deps — { db, ai, tools, env, settings?, log?, waitUntil?, core? }; waitUntil(promise) keeps background work alive (Vercel);
// core — { render, onCommit } of the core: the agent's changes write rendered Outbox rows and deliver them after COMMIT.
export function createTurns({ db, ai, tools, env = process.env, settings = null, log = console, waitUntil = null, core = {} }) {
  const now = clockNow;
  const conf = () => settingsOf(db, { settings });

  // §10: the rate windows (rate_limits); → true when over.
  async function over(key, max, windowMs) {
    const at = now().getTime();
    const start = new Date(Math.floor(at / windowMs) * windowMs);
    const r = await db.one(`INSERT INTO rate_limits (key, window_start, count) VALUES ($1, $2, 1)
      ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1 RETURNING count`, [key, start]);
    return r.count > max;
  }

  const lock = (id, turnId) => db.one(`UPDATE conversations SET turn_lock_until = $3, turn_lock_id = $2
    WHERE id = $1 AND (turn_lock_until IS NULL OR turn_lock_until < $4) RETURNING *`,
    [id, turnId, new Date(now().getTime() + LOCK_MS), now()]);
  const unlock = (id, turnId) => db.query('UPDATE conversations SET turn_lock_until = NULL, turn_lock_id = NULL WHERE id = $1 AND turn_lock_id = $2',
    [id, turnId]);

  async function saveMessage(conv, role, text, { blocks = null, turnId = null } = {}) {
    const at = now();
    const m = await db.one(`INSERT INTO messages (conversation_id, role, text, blocks, turn_id, created_at) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id`, [conv.id, role, text, blocks ? JSON.stringify(blocks) : null, turnId, at]);
    await db.query(`UPDATE conversations SET message_count = message_count + 1, last_message_at = $2, updated_at = $2 WHERE id = $1`, [conv.id, at]);
    return m.id;
  }

  // 07 §13.1: each message of the client moves the qualifier to «this message + 10 min»; a failure never stops the turn.
  async function requalify(conv, messageId) {
    if (conv.kind !== 'client' || !conv.client_id) return;
    try {
      const jobs = await db.tx(q => scheduleQualify(q, { conversationId: conv.id, messageId }, { now }));
      const bg = publishJobs(db, jobs, { env, now }).catch(e => log.warn?.('qualify publish failed:', e.message));
      if (waitUntil) waitUntil(bg); else await bg;
    } catch (e) {
      log.error?.('qualify schedule failed:', e.message);
    }
  }

  async function journal(turnId, conv, run, role = 'tools') {
    try {
      await db.query(`INSERT INTO agent_runs (turn_id, conversation_id, agent, role, provider, model, fallback, steps, tools, input_tokens,
        output_tokens, cached_tokens, cost_usd, ms, first_event_ms, ok, error, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [turnId, conv.id, run.agent, role, run.provider ?? null, run.model ?? null, !!run.fallback, run.steps ?? 0,
        [...new Set((run.calls ?? []).map(c => c.name))], run.usage?.input ?? 0, run.usage?.output ?? 0, run.usage?.cached ?? 0,
        run.costUsd ?? 0, run.ms ?? null, run.firstEventMs ?? null, run.ok !== false, run.error ?? null, now()]);
    } catch (e) {
      log.error?.('agent_runs write failed:', e.message);
    }
  }

  // §6.2: the last 12 user / assistant / staff messages (masked, staff marked), the summary in front; notes never.
  async function history(conv, beforeId, lang) {
    const rows = await db.query(`SELECT role, text FROM messages WHERE conversation_id = $1 AND id < $2 AND role <> 'note'
      ORDER BY id DESC LIMIT ${HISTORY}`, [conv.id, beforeId]);
    const asc = rows.reverse();
    const out = asc.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user',
      parts: [{ type: 'text', text: (m.role === 'staff' ? 'Менеджер: ' : '') + mask(m.text, lang).text }] }));
    if (conv.summary) out.unshift({ role: 'user', parts: [{ type: 'text', text: `[summary] ${conv.summary}` }] });
    return { messages: out, plain: asc.map(m => ({ role: m.role, text: mask(m.text, lang).text })) };
  }

  async function clientInfo(actor, state) {
    if (!actor.id) return { known: false, phone: state.contactPhone ? 'yes' : 'no', holds: [] };
    const c = await db.one('SELECT name, phone, phone_verified FROM clients WHERE id = $1', [actor.id]);
    const holds = await db.query(`SELECT apartment_no, expires_at FROM bookings WHERE client_id = $1 AND status = 'held' ORDER BY expires_at`, [actor.id]);
    const phone = c?.phone ? (c.phone_verified ? 'yes(verified)' : 'yes') : state.contactPhone ? 'yes' : 'no';
    return { known: !!(c?.name || c?.phone), phone, holds: holds.map(h => ({ apartmentNo: h.apartment_no, until: new Date(h.expires_at).toISOString() })) };
  }

  // §6.1: the memory is updated by code from the tools' arguments and results — never from the model's words.
  function remember(state, runs) {
    const s = { ...state };
    for (const run of runs) {
      for (const c of run.calls ?? []) {
        if (!c.ok) continue;
        if (c.name === 'search_apartments') {
          const { limit, sort, status, ...filters } = c.args ?? {};
          s.filters = filters;
          s.shown = (c.result?.items ?? []).slice(0, 3).map(a => a.no);
        }
        if (c.name === 'get_apartment' && c.args?.no != null) s.focusApartment = c.args.no;
        if (c.name === 'create_booking' && c.args?.apartmentNo != null) s.focusApartment = c.args.apartmentNo;
        if (c.name === 'calc_installment') {
          s.finance = { ...(s.finance ?? {}), ...(c.args?.months ? { months: c.args.months } : {}),
            ...(c.args?.downPct != null ? { downPct: c.args.downPct } : {}) };
          if (c.args?.no != null && s.focusApartment == null) s.focusApartment = c.args.no;
        }
      }
    }
    const agents = runs.map(r => r.agent).filter(a => a && a !== 'router');
    if (agents.length) s.lastAgents = agents;
    return s;
  }

  // §11.3: the blocks come from the tool results, not from the text: cards, the installment table, the confirmation card.
  function blocksOf(run, lang) {
    const out = [];
    const cards = [];
    for (const c of run.calls ?? []) {
      if (!c.ok || !c.result) continue;
      if (c.name === 'search_apartments') cards.push(...(c.result.items ?? []).slice(0, 3));
      if (c.name === 'get_apartment') cards.push(c.result);
      if (c.name === 'calc_installment' || c.name === 'compare_finance') out.push({ type: 'table', data: { tool: c.name, ...c.result } });
      if (c.name === 'my_bookings' && c.result.items?.length) out.push({ type: 'bookings', data: { items: c.result.items.slice(0, 5).map(b => bookingCard(b, lang)) } });
    }
    const seen = new Set();
    const uniq = cards.filter(a => a?.no != null && !seen.has(a.no) && seen.add(a.no));
    if (uniq.length) out.unshift({ type: 'apartments', data: { items: uniq } });
    for (const p of run.pending ?? []) out.push(confirmCard(p, lang, env));
    if (run.citations?.length) out.push({ type: 'citations', data: { items: run.citations, mode: run.kb?.mode ?? null } });
    return out;
  }

  // §12: up to 3 buttons by the agents of the turn and the memory, none already pressed in this dialog.
  function suggestionsOf(runs, state, lang, more) {
    if (runs.some(r => r.pending?.length)) return [];
    const btn = (key, vars, intent, payload) => ({ label: t(lang, key, vars), intent, payload });
    const out = [];
    const last = runs.at(-1);
    const no = state.focusApartment ?? state.shown?.[0] ?? null;
    if (!last || last.ok === false) out.push(...fallbackSuggestions(lang));
    else if (last.agent === 'apt_finder' && no != null) {
      out.push(btn('agent.sg.open_3d', { no }, 'open_3d', { no }), btn('agent.sg.installment', { no }, 'calc_installment', { no }),
        btn('agent.sg.book', { no }, 'book', { apartmentNo: no }));
    } else if (last.agent === 'finance') {
      const months = state.finance?.months;
      if (no != null && months && months < 36) out.push(btn('agent.sg.months', { months: 36 }, 'calc_installment', { no, months: 36 }));
      out.push({ label: t(lang, 'agent.sg.mortgage'), intent: null, payload: {}, text: t(lang, 'agent.sg.mortgage') });
      if (no != null) out.push(btn('agent.sg.book', { no }, 'book', { apartmentNo: no }));
    } else if (last.agent === 'kb_consultant') {
      // 07 §12: the neighbouring topics of the base (the found fragments the answer did not cite), then the manager
      const cited = new Set((last.citations ?? []).map(c => c.n));
      const seen = new Set();
      for (const c of last.kb?.chunks ?? []) {
        const topic = c.heading.split(' — ').at(-1);
        if (cited.has(c.n) || seen.has(topic) || seen.size >= 2) continue;
        seen.add(topic);
        out.push({ label: topic, intent: null, payload: {}, text: topic });
      }
      out.push(btn('agent.sg.ask_manager', {}, 'call_manager', {}));
      if (!last.kb) out.push(btn('agent.suggest.find', {}, 'show_free', {}));
    } else if (last.agent === 'booking') {
      out.push(btn('confirm.btn.my_bookings', {}, 'my_bookings', {}));
    }
    for (const a of more ?? []) {
      const topic = t(lang, `agent.topic.${a}`);
      if (topic) out.push({ label: t(lang, 'agent.sg.more', { topic }), intent: null, payload: {}, text: topic });
    }
    const pressed = new Set(state.pressed ?? []);
    const key = s => `${s.intent ?? s.text}:${JSON.stringify(s.payload ?? {})}`;
    return out.filter(s => !pressed.has(key(s))).slice(0, 3);
  }

  // 07 §11.4: a button with an intent is served by code, no model.
  async function byIntent({ intent, payload = {} }, toolCtx, state, lang, channel) {
    const run = { agent: intent === 'call_manager' ? 'handoff' : 'scripted', calls: [], pending: [], ok: true, provider: 'scripted' };
    const call = async (name, args) => {
      const res = await tools.run(name, args, toolCtx);
      run.calls.push({ name, args, ok: !!res.ok, result: res.ok ? (res.pending ? res.preview : res.out) : null, error: res.error ?? null });
      if (res.pending) run.pending.push(res);
      return res;
    };
    if (intent === 'show_free') {
      const filters = { ...(state.filters ?? {}), ...payload };
      const r = await call('search_apartments', { ...filters, limit: 3 });
      run.agent = 'apt_finder';
      run.text = r.ok && r.out.items.length ? t(lang, 'agent.free') : t(lang, 'agent.none_free');
    } else if (intent === 'open_3d') {
      const no = payload.no ?? state.focusApartment;
      run.text = no != null ? t(lang, 'agent.open_3d', { no, url: aptUrl(no, lang, env) }) : t(lang, 'agent.need_apartment');
    } else if (intent === 'calc_installment') {
      const no = payload.no ?? state.focusApartment;
      run.agent = 'finance';
      if (no == null) run.text = t(lang, 'agent.need_apartment');
      else {
        const r = await call('calc_installment', { no, ...(payload.months ? { months: payload.months } : {}) });
        run.text = r.ok ? t(lang, 'agent.installment', { no }) : r.message;
      }
    } else if (intent === 'book') {
      run.agent = 'booking';
      const r = await call('create_booking', { apartmentNo: payload.apartmentNo ?? state.focusApartment });
      run.text = r.ok ? t(lang, 'confirm.check') : r.message;
      if (!r.ok) run.ok = false;
    } else if (intent === 'book_viewing') {
      run.agent = 'booking';
      run.text = t(lang, 'agent.viewing_when');
    } else if (intent === 'my_bookings') {
      run.agent = 'booking';
      const r = await call('my_bookings', {});
      const items = r.ok ? r.out.items : [];
      run.text = t(lang, items.length ? 'agent.bookings' : 'agent.no_bookings');      // the bookings themselves are cards (blocksOf)
    } else if (intent === 'call_manager') {
      await call('call_manager', {});
      run.text = template('handoff', lang).text;
    } else {
      return { ...menu(lang, { channel }), agent: 'scripted', calls: [], pending: [], ok: true };
    }
    return run;
  }

  // 07 §11.1: one message → one answer. input — { text, intent?, payload? }; sink(event) — the stream (§11.2).
  async function runTurn({ conversationId, text = '', intent = null, payload = {}, actor, channel, sink = () => {}, ip = null }) {
    const turnId = randomUUID();
    let conv = await db.one('SELECT * FROM conversations WHERE id = $1', [conversationId]);
    if (!conv) throw new Error('no conversation');
    const lang0 = conv.lang;
    const s = await conf();
    const limits = s.chat_limits;
    const reply = (name, lang = lang0) => {
      const tpl = template(name, lang);
      sink({ type: 'text', agent: 'scripted', delta: tpl.text });
      sink({ type: 'suggestions', data: tpl.suggestions });
      sink({ type: 'done', data: { turnId, messageId: null } });
      return { turnId, status: name, text: tpl.text };
    };

    // 1. limits (§10)
    const who = actor.id ? `chat:client:${actor.id}` : null;
    if ((who && (await over(`${who}:m`, limits.perMinute, 60e3) || await over(`${who}:d`, limits.perDay, 86400e3)))
      || (channel === 'web' && ip && await over(`chat:ip:${ip}`, 30, 60e3))) return reply('rate_limited');
    const userTurns = (await db.one(`SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND role = 'user'`, [conv.id])).n;
    if (userTurns >= limits.perConversation) {
      const txt = t(lang0, 'agent.too_long');
      sink({ type: 'text', agent: 'scripted', delta: txt });
      sink({ type: 'suggestions', data: [{ label: t(lang0, 'agent.btn.new_dialog'), intent: 'new_dialog', payload: {} }] });
      sink({ type: 'done', data: { turnId, messageId: null } });
      return { turnId, status: 'too_long', text: txt };
    }
    let input = String(text ?? '');
    const cut = input.length > MAX_TEXT;
    if (cut) input = input.slice(0, MAX_TEXT);

    // 3. the client's message (stored without a card number); while another turn runs it just waits (§11.1 step 2).
    const masked = mask(input, lang0);
    const stored = forStorage(input, lang0);
    const userMsgId = await saveMessage(conv, 'user', stored || (intent ? `[${intent}]` : ''), { turnId,
      blocks: intent ? [{ type: 'press', data: { intent, payload } }] : null });
    await requalify(conv, userMsgId);
    const got = await lock(conv.id, turnId);
    if (!got) return { turnId, status: 'queued' };
    conv = got;
    try {
      const out = await answer({ conv, turnId, userMsgId, input, masked, cut, intent, payload, actor, channel, sink });
      // a message that came while this turn ran → one more turn, up to 2 in a row
      for (let i = 0; i < 2; i++) {
        // the client's messages stored while we answered: the last one is answered, the earlier ones are its history
        const next = await db.one(`SELECT id, text FROM messages WHERE conversation_id = $1 AND role = 'user' AND id > $2
          ORDER BY id DESC LIMIT 1`, [conv.id, out.lastUserId ?? userMsgId]);
        if (!next) break;
        const c2 = await db.one('SELECT * FROM conversations WHERE id = $1', [conv.id]);
        const r2 = await answer({ conv: c2, turnId: randomUUID(), userMsgId: next.id, input: next.text, masked: mask(next.text, c2.lang),
          cut: false, intent: null, payload: {}, actor, channel, sink });
        out.lastUserId = next.id;
        out.followUps = (out.followUps ?? 0) + 1;
        out.lastFollowUp = r2;
      }
      return out;
    } finally {
      await unlock(conv.id, turnId);
    }
  }

  async function answer({ conv, turnId, userMsgId, input, masked, cut, intent, payload, actor, channel, sink }) {
    const state = { ...(conv.state ?? {}) };
    if (masked.phones.length) { state.contactPhone = masked.phones.at(-1); state.contactPhoneVerified = false; }
    if (intent) state.pressed = [...new Set([...(state.pressed ?? []), `${intent}:${JSON.stringify(payload ?? {})}`])].slice(-20);
    const deadline = now().getTime() + TURN_MS;
    const out = { lang: conv.lang, runs: [], texts: [], blocks: [], suggestions: null, more: [] };
    const toolCtx = { actor, source: 'agent', lang: out.lang, turnId, conversationId: conv.id, contactPhone: state.contactPhone ?? null,
      summary: conv.summary ?? '', onCommit: core.onCommit ?? null, render: core.render ?? null };
    // say — one more piece of the answer; streamed — its text already went to the sink as deltas.
    out.say = (agent, txt, { streamed = false } = {}) => {
      if (!txt) return;
      if (!streamed) sink({ type: 'text', agent, delta: (out.texts.length ? '\n\n' : '') + txt });
      out.texts.push(txt);
    };
    if (cut) out.say('scripted', t(out.lang, 'agent.long_message'));
    if (masked.card) out.say('scripted', t(out.lang, 'agent.card_in_chat'));

    // 07 §9: with a manager the agent keeps quiet (the message is stored, the group hears of it); after 24 h without a manager's
    // reply the dialog is back with the AI and this turn is answered as usual.
    let mode = conv.mode;
    if (mode === 'human') mode = (await clientWroteToHuman(db, { conversationId: conv.id, text: input }, { now, env, ...core })).mode;
    const sc = shortcut({ text: input, intent, payload, mode });
    if (sc?.kind === 'human') {
      sink({ type: 'done', data: { turnId, messageId: null } });
      return { turnId, status: 'human' };
    }
    let handled = false;
    if (sc?.kind === 'consent') {
      const r = await textConsent(tools, input, toolCtx, env);
      if (r) {
        handled = true;
        out.say('booking', r.text);
        emitBlocks(r.blocks, out, sink);
        out.suggestions = r.suggestions;
        out.runs.push({ agent: 'booking', provider: 'scripted', calls: [], ok: r.status === 'executed', error: r.error ?? null, steps: 0 });
      }
    }
    if (!handled && sc?.kind === 'intent') {
      handled = true;
      sink({ type: 'status', data: { text: statusText(sc.agent ?? 'smalltalk', out.lang) } });
      const r = await byIntent(sc, toolCtx, state, out.lang, channel);
      out.runs.push(r);
      out.say(r.agent, r.text);
      emitBlocks(blocksOf(r, out.lang), out, sink);
      if (r.suggestions) out.suggestions = r.suggestions;
    }
    if (!handled && sc?.kind === 'smalltalk') {
      handled = true;
      const r = smalltalk(sc.template, out.lang);
      out.runs.push(r);
      out.say('smalltalk', r.text);
      if (sc.template === 'hello') out.suggestions = menu(out.lang, { channel }).suggestions.slice(0, 3);
    }
    if (!handled) {
      const h = await history(conv, userMsgId, conv.lang);
      const plan = await route(ai, { message: masked.text, history: h.plain, memory: memoryLine(state), conversationLang: conv.lang,
        turnId, deadline, log });
      out.lang = toolCtx.lang = plan.lang;
      out.more = plan.more;
      out.runs.push({ agent: 'router', role: 'fast', provider: plan.call?.provider ?? 'scripted', model: plan.call?.model ?? null,
        usage: plan.call?.usage ?? usage0, costUsd: plan.call?.costUsd ?? 0, ms: plan.call?.ms ?? 0, steps: 0, calls: [],
        ok: !plan.error, error: plan.error ?? null });
      await playPlan({ plan, h, conv, state, toolCtx, out, sink, deadline, channel, message: masked.text });
    }

    // §11.3: one assistant message — the full text, the blocks and the buttons.
    const answerRuns = out.runs.filter(r => r.agent !== 'router');
    const nextState = remember(state, answerRuns);
    const suggestions = out.suggestions ?? suggestionsOf(answerRuns, nextState, out.lang, out.more);
    sink({ type: 'suggestions', data: suggestions });
    const full = out.texts.join('\n\n');
    const messageId = await saveMessage(conv, 'assistant', full, { turnId,
      blocks: [...out.blocks, ...(suggestions.length ? [{ type: 'suggestions', data: suggestions }] : [])] });
    await db.query('UPDATE conversations SET state = $2, lang = $3, updated_at = $4 WHERE id = $1',
      [conv.id, JSON.stringify(nextState), out.lang, now()]);
    for (const r of out.runs) await journal(turnId, conv, r, r.role ?? 'tools');
    const bg = summarize(conv.id).catch(e => log.error?.('summary failed:', e.message));
    if (waitUntil) waitUntil(bg); else await bg;
    sink({ type: 'done', data: { turnId, messageId } });
    return { turnId, status: 'answered', messageId, text: full, blocks: out.blocks, suggestions, lang: out.lang,
      agents: answerRuns.map(r => r.agent) };
  }

  async function playPlan({ plan, h, conv, state, toolCtx, out, sink, deadline, channel, message }) {
    const lang = out.lang;
    if (plan.injection) {
      out.say('scripted', template('injection', lang).text);
      out.suggestions = [{ label: t(lang, 'agent.menu.call_manager'), intent: 'call_manager', payload: {} }];
      return;
    }
    if (plan.handoff) {
      sink({ type: 'status', data: { text: statusText('handoff', lang) } });
      const recent = h.plain.filter(m => m.role === 'user').slice(-3).map(m => m.text.slice(0, 200)).join(' / ');
      const r = await byIntent({ intent: 'call_manager' }, { ...toolCtx, summary: conv.summary || recent || message.slice(0, 200) },
        state, lang, channel);
      out.runs.push(r);
      out.say('handoff', r.text);
      out.suggestions = [];
      return;
    }
    if (!plan.agents.length) {
      const m = menu(lang, { channel });
      out.say('scripted', m.text);
      out.suggestions = m.suggestions;
      return;
    }
    const turn = { pending: [] };
    let prev = null;
    for (const agent of plan.agents) {
      if (now().getTime() >= deadline) { out.say('scripted', template('turn_timeout', lang).text); break; }
      sink({ type: 'status', data: { text: statusText(agent, lang) } });
      if (agent === 'smalltalk') {
        const r = smalltalk(BOT.test(message) ? 'bot' : 'hello', lang);
        out.runs.push(r);
        out.say('smalltalk', r.text);
        continue;
      }
      if (!MODEL_AGENTS.has(agent)) continue;
      const context = contextBlock({ now: now().toISOString(), channel, lang, client: await clientInfo(toolCtx.actor, state), state,
        digest: digestOf(prev) });
      let started = false;
      const r = await runAgent({ ai, tools, agent, task: plan.tasks[agent] ?? null, message, context, history: h.messages, toolCtx,
        lang, deadline, turn, onEvent: ev => {
          if (ev.type === 'text') { sink({ ...ev, delta: (!started && out.texts.length ? '\n\n' : '') + ev.delta }); started = true; }
          else if (ev.type === 'reset') { sink(ev); started = false; }
        } });
      out.runs.push(r);
      if (r.error === 'unavailable') {
        // 06 §16: no model answered — the menu (NFR-REL-03)
        const m = menu(lang, { channel });
        out.say('scripted', m.text);
        out.suggestions = m.suggestions;
        break;
      }
      if (r.error === 'turn_timeout') { out.say('scripted', template('turn_timeout', lang).text); break; }
      out.say(agent, prev ? stripGreeting(r.text) : r.text, { streamed: started });
      emitBlocks(blocksOf(r, lang), out, sink);
      if (r.error === 'refusal' || r.error === 'max_steps') out.suggestions = fallbackSuggestions(lang);
      prev = r;
    }
  }

  // 07 §14: the head's analyst — no router, every message goes straight to the agent `analyst`, whose tools only read.
  // The answer is the text and one table built by code from the last report of the turn (12 §11).
  async function runAnalyst({ conversationId, text = '', actor, sink = () => {} }) {
    const turnId = randomUUID();
    let conv = await db.one('SELECT * FROM conversations WHERE id = $1', [conversationId]);
    if (conv?.kind !== 'analyst') throw new Error('no conversation');
    const lang = conv.lang;
    const finish = (txt, messageId = null) => {
      if (txt) sink({ type: 'text', agent: 'analyst', delta: txt });
      sink({ type: 'done', data: { turnId, messageId } });
    };
    const limits = (await conf()).chat_limits;
    const who = `chat:staff:${actor.id}`;
    if (await over(`${who}:m`, limits.perMinute, 60e3) || await over(`${who}:d`, limits.perDay, 86400e3)) {
      const txt = template('rate_limited', lang).text;
      finish(txt);
      return { turnId, status: 'rate_limited', text: txt };
    }
    const input = String(text ?? '').slice(0, MAX_TEXT);
    const userMsgId = await saveMessage(conv, 'user', forStorage(input, lang), { turnId });
    const got = await lock(conv.id, turnId);
    if (!got) return { turnId, status: 'queued' };
    conv = got;
    try {
      const h = await history(conv, userMsgId, lang);
      const toolCtx = { actor, source: 'agent', lang, turnId, conversationId: conv.id };
      const r = await runAgent({ ai, tools, agent: 'analyst', message: mask(input, lang).text, context: analystContext({ now: now(), lang }),
        history: h.messages, toolCtx, lang, deadline: now().getTime() + TURN_MS, onEvent: sink });
      let full = r.text;
      if (r.error === 'unavailable') { full = t(lang, 'err.ai_unavailable'); sink({ type: 'text', agent: 'analyst', delta: full }); }
      else if (r.error === 'turn_timeout') { full = template('turn_timeout', lang).text; sink({ type: 'text', agent: 'analyst', delta: full }); }
      const table = r.ok !== false ? analystTable(r, lang) : null;
      const blocks = [];
      if (table) emitBlocks([table], { blocks }, sink);
      const messageId = await saveMessage(conv, 'assistant', full, { turnId, blocks: blocks.length ? blocks : null });
      await journal(turnId, conv, r);
      finish(null, messageId);
      return { turnId, status: 'answered', messageId, text: full, blocks, tools: r.calls.map(c => c.name) };
    } finally {
      await unlock(conv.id, turnId);
    }
  }

  // §6.3: more than 20 messages and the summary is 10 messages old → the fast model rewrites it (≤ 600 chars, no names or phones).
  async function summarize(conversationId) {
    const c = await db.one('SELECT id, summary, message_count, state, lang FROM conversations WHERE id = $1', [conversationId]);
    const at = c.state?.summaryAt ?? 0;
    if (!ai || c.message_count <= 20 || c.message_count - at < 10) return null;
    const old = await db.query(`SELECT role, text FROM messages WHERE conversation_id = $1 AND role IN ('user','assistant','staff')
      ORDER BY id DESC OFFSET ${HISTORY}`, [c.id]);
    if (!old.length) return null;
    const lines = old.reverse().map(m => `${m.role === 'user' ? 'client' : m.role === 'staff' ? 'manager' : 'assistant'}: ${mask(m.text, c.lang).text}`);
    const r = await ai.chat({ role: 'fast', agent: 'summarizer', maxOutputTokens: 300,
      system: 'Summarize this sales chat about apartments in up to 600 characters: what the client is looking for, what was shown and '
        + 'calculated, what was agreed. No names, no phone numbers. Write in the language of the dialog. Plain text.',
      messages: [{ role: 'user', parts: [{ type: 'text', text: `${c.summary ? `[previous summary] ${c.summary}\n` : ''}${lines.join('\n')}` }] }] });
    if (r.provider === 'scripted') return null;
    const text = mask(r.parts.filter(p => p.type === 'text').map(p => p.text).join('').trim(), c.lang).text.slice(0, 600);
    if (!text) return null;
    await db.query(`UPDATE conversations SET summary = $2, state = state || $3 WHERE id = $1`,
      [c.id, text, JSON.stringify({ summaryAt: c.message_count })]);
    return text;
  }

  return { runTurn, runAnalyst, summarize };
}


// The second agent does not greet again (§11.3).
const stripGreeting = s => String(s ?? '').replace(/^(здравствуйте|привет|добрый день|assalomu alaykum|salom|hello|hi)[!,.\s]*/iu, '');

function emitBlocks(bs, out, sink) {
  for (const b of bs) { sink({ type: 'block', data: b }); out.blocks.push(b); }
}
