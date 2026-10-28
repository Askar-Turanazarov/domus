// npm run eval:agents [-- --primary-off] [--pause 20000] [--only a01,a02] — the 20 questions of eval/agents-control.json on the real models
// (15 §5.1, §5.3) → eval/reports/agents-<date>.md (with --primary-off: agents-<date>-reserve.md).
// A fresh in-memory base (the base seed and the knowledge base with vectors), one new client and dialog per question,
// the questions one by one. --primary-off: settings.ai.geminiDisabled with a Claude key, else primaryDisabled; set back in the end.
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../server/env.js';
import { createDb } from '../server/db/index.js';
import { createSettings } from '../server/core/settings.js';
import { createAi } from '../server/ai/index.js';
import { createKb } from '../server/kb/retrieve.js';
import { ingest } from '../server/kb/ingest.js';
import { createTools } from '../server/tools/registry.js';
import { createTurns } from '../server/agents/turn.js';
import { template } from '../server/agents/scripted.js';
import { knownNumbers, ungrounded } from '../server/agents/grounding.js';
import { anonymousClient } from '../server/core/clients.js';
import { t } from '../server/i18n/index.js';
import { now } from '../server/core/clock.js';
import { checkCase, summarize, renderReport } from '../server/agents/eval.js';

loadEnv();
const root = path.join(import.meta.dirname, '..');
const args = process.argv.slice(2);
const primaryOff = args.includes('--primary-off');
const pauseAt = args.indexOf('--pause');
const pause = pauseAt >= 0 ? Number(args[pauseAt + 1]) : 20000;
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
if (!process.env.GEMINI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
  console.error('No model key (GEMINI_API_KEY / ANTHROPIC_API_KEY): the control set needs the real models.');
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const count = async (db, sql, p) => (await db.one(sql, p)).n;
const db = createDb({ url: '', dir: 'memory://' });
const settings = createSettings(db);
let switched = null;
try {
  await db.ready();
  const ai = createAi({ db, env: process.env, settings });
  const k = await ingest({ db, ai, root: path.join(root, 'kb') });
  console.log(`KB: ${k.chunks} chunks, ${k.embedded} vectors${k.partial ? ' (partial: words only for some)' : ''}.`);
  if (k.partial) await sleep(65_000);      // the free Gemini tier counts a minute: let the embeddings window pass
  const kb = createKb({ db, ai, env: process.env });
  const base = createTools({ db, settings, env: process.env, kb });
  const log = [];
  const tools = { ...base, run: async (name, a, ctx) => {
    const res = await base.run(name, a, ctx);
    log.push({ conv: ctx.conversationId, name, args: a, res, mutates: !!base.get(name)?.mutates });
    return res;
  } };
  const turns = createTurns({ db, ai, tools, env: process.env, settings, log: { error: () => {}, warn: () => {}, info: () => {} } });

  if (primaryOff) {
    const sw = await settings.get('ai');
    switched = { ...sw };
    await settings.set('ai', process.env.ANTHROPIC_API_KEY ? { ...sw, geminiDisabled: true } : { ...sw, primaryDisabled: true });
  }
  const mode = primaryOff ? (process.env.ANTHROPIC_API_KEY ? 'Gemini выключен (Claude)' : 'основная модель выключена (вторая модель Gemini)')
    : (process.env.ANTHROPIC_API_KEY ? 'по умолчанию (Claude + Gemini)' : 'по умолчанию (Gemini, без ключа Claude)');

  const control = JSON.parse(fs.readFileSync(path.join(root, 'eval', 'agents-control.json'), 'utf8'))
    .filter(c => !only || only.includes(c.id));
  const rows = [];
  for (const [i, c] of control.entries()) {
    if (i) await sleep(pause);
    const client = await anonymousClient(db, { lang: c.lang });
    const conv = await db.one(`INSERT INTO conversations (kind, client_id, channel, lang, created_at, updated_at)
      VALUES ('client', $1, 'web', $2, $3, $3) RETURNING id`, [client.id, c.lang, now()]);
    const bookings0 = await count(db, 'SELECT count(*)::int AS n FROM bookings');
    const t0 = performance.now();
    let firstMs = null;
    const sink = ev => { if (firstMs === null && (ev.type === 'status' || ev.type === 'text')) firstMs = Math.round(performance.now() - t0); };
    let o;
    try {
      const out = await turns.runTurn({ conversationId: conv.id, text: c.q, actor: { type: 'client', id: client.id, role: 'client', channel: 'web' },
        channel: 'web', sink });
      const totalMs = Math.round(performance.now() - t0);
      const lang = out.lang ?? c.lang;
      const text = out.text ?? '';
      const calls = log.filter(x => x.conv === conv.id);
      const runs = (await db.query(`SELECT agent, provider, model, fallback, error, input_tokens, output_tokens, cost_usd FROM agent_runs
        WHERE conversation_id = $1 ORDER BY id`, [conv.id])).map(r => ({ agent: r.agent, provider: r.provider, model: r.model,
        fallback: r.fallback, error: r.error, input: r.input_tokens, output: r.output_tokens, costUsd: Number(r.cost_usd) || 0 }));
      const known = knownNumbers({ calls: calls.map(x => ({ args: x.args, result: x.res.ok ? (x.res.pending ? x.res.preview : x.res.out) : null })),
        message: c.q });
      const phrase = t(lang, 'agent.ungrounded');
      o = {
        text, lang, agents: out.agents ?? [], tools: calls.map(x => ({ name: x.name, mutates: x.mutates })),
        pending: calls.filter(x => x.res.pending).length,
        bookingsDelta: (await count(db, 'SELECT count(*)::int AS n FROM bookings')) - bookings0,
        injection: text === template('injection', lang).text && !calls.length,
        ungrounded: ungrounded(text, known), scrubbed: text.split(phrase).length - 1,
        citations: (out.blocks ?? []).some(b => b.type === 'citations'),
        kbRefused: runs.some(r => r.error === 'no_kb_answer'),
        firstMs, totalMs, runs
      };
    } catch (e) {
      o = { error: e.message, text: '', agents: [], tools: [], runs: [], firstMs, totalMs: Math.round(performance.now() - t0) };
    }
    const r = checkCase(c, o);
    rows.push({ c, o, r });
    console.log(`${c.id} ${r.status}${r.fails.length ? ' — ' + r.fails.join('; ') : ''}`);
  }

  const result = summarize(rows);
  const date = now().toISOString().slice(0, 10);
  fs.mkdirSync(path.join(root, 'eval', 'reports'), { recursive: true });
  const file = path.join(root, 'eval', 'reports', `agents-${date}${primaryOff ? '-reserve' : ''}${only ? '-partial' : ''}.md`);
  fs.writeFileSync(file, renderReport(result, { date, mode, primaryOff }));
  console.log(JSON.stringify(result.metrics), result.pass ? 'PASS' : 'FAIL');
  console.log(`Report: ${path.relative(root, file)}`);
  if (!result.pass) process.exitCode = 1;
} finally {
  if (switched) await settings.set('ai', switched).catch(() => {});
  await db.close();
}
