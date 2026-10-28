// npm run bench -- --url https://… (15 §7, DoD-6): what a script can measure of NFR-PERF; the rest (PERF-01, -02, -08:
// renderer.info, Lighthouse) is written into docs/perf.md by hand. Prints a Markdown table to paste there.
//   --url <base>        default http://localhost:3000
//   --chat <n>          questions of eval/agents-control.json for PERF-03/04 (default 20, 0 — skip; each is a real model call)
//   --write             PERF-06 by-ref and PERF-07: makes one hold (a test booking) — local or a test base only
//   --tg                PERF-05: signed webhook updates (TELEGRAM_WEBHOOK_SECRET from the environment)
// Staff pages (PERF-07, dashboard summary): BENCH_LOGIN / BENCH_PASSWORD from the environment, never as arguments.
// Cold start (the first request) is a separate line and is not in the medians.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const BASE = String(opt('url', 'http://localhost:3000')).replace(/\/$/, '');
const CHAT = Number(opt('chat', 20));
const WRITE = args.includes('--write'), TG = args.includes('--tg');
const sleep = ms => new Promise(ok => setTimeout(ok, ms));

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)] : NaN; };
const ms = x => (Number.isFinite(x) ? `${Math.round(x)} мс` : '—');
const sec = x => (Number.isFinite(x) ? `${(x / 1000).toFixed(2)} с` : '—');
const rows = [];
const row = (id, what, goal, value, ok, note = '') => rows.push({ id, what, goal, value, ok, note });

async function timed(path, init = {}) {
  const t0 = performance.now();
  const res = await fetch(BASE + path, init);
  const body = await res.arrayBuffer();
  return { ms: performance.now() - t0, status: res.status, res, body };
}

async function series(path, n, init) {
  for (let i = 0; i < 5; i++) await timed(path, init);         // warm-up
  const xs = [];
  for (let i = 0; i < n; i++) {
    const r = await timed(path, init);
    if (r.status >= 400) throw new Error(`${path} → ${r.status}`);
    xs.push(r.ms);
  }
  return xs;
}

let cookie = null;
async function staffLogin() {
  const { BENCH_LOGIN: login, BENCH_PASSWORD: password } = process.env;
  if (!login || !password) return false;
  const res = await fetch(BASE + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'domus-admin' },
    body: JSON.stringify({ login, password }) });
  if (!res.ok) { console.warn(`staff login → ${res.status}`); return false; }
  cookie = res.headers.get('set-cookie').split(';')[0];
  return true;
}
const staff = () => ({ headers: { Cookie: cookie, 'X-Requested-With': 'domus-admin' } });

// SSE of /api/chat: the time to the first visible event (status or a text delta, D-13), to the first text and to done.
async function ask(q, lang) {
  const t0 = performance.now();
  const res = await fetch(BASE + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ text: q, lang, context: { page: 'building' } }) });
  if (!res.ok) throw new Error(`chat → ${res.status}`);
  let first = NaN, text = NaN, done = NaN, failed = false, buf = '';
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    for (const m of buf.matchAll(/^event: (\w+)$/gm)) {
      if (Number.isNaN(first) && ['status', 'text'].includes(m[1])) first = performance.now() - t0;
      if (Number.isNaN(text) && m[1] === 'text') text = performance.now() - t0;
      if (m[1] === 'done' || m[1] === 'error') { done = performance.now() - t0; failed = m[1] === 'error'; }
    }
    buf = buf.slice(buf.lastIndexOf('\n') + 1);
    if (!Number.isNaN(done)) break;
  }
  return { first, text, done, failed };
}

async function main() {
  console.log(`bench → ${BASE}`);
  const cold = await timed('/api/apartments/status');
  row('—', 'Холодный старт (первый запрос)', '—', ms(cold.ms), null, 'не входит в медианы');

  // PERF-06: the core API, 50 requests after the warm-up
  for (const [path, what] of [['/api/apartments/status', 'GET /api/apartments/status'], ['/api/buildings/chinor-park', 'GET /api/buildings/chinor-park']]) {
    const xs = await series(path, 50);
    row('PERF-06', what, 'p95 < 300 мс', `p50 ${ms(pct(xs, 50))} · p95 ${ms(pct(xs, 95))}`, pct(xs, 95) < 300);
  }

  const loggedIn = await staffLogin();
  if (loggedIn) {
    const xs = [], srv = [];
    for (let i = 0; i < 10; i++) {
      if (i) await sleep(2100);                                    // past the 2 s answer cache: each one is computed
      const r = await timed('/api/dashboard/summary?period=7d', staff());
      if (r.status !== 200) throw new Error(`summary → ${r.status}`);
      xs.push(r.ms);
      const m = /dur=([\d.]+)/.exec(r.res.headers.get('server-timing') ?? '');
      if (m) srv.push(Number(m[1]));
    }
    row('12 §9', 'Дашборд summary (сервер)', '< 100 мс', srv.length ? `p50 ${ms(pct(srv, 50))} · p95 ${ms(pct(srv, 95))}` : `полный ответ p50 ${ms(pct(xs, 50))}`,
      srv.length ? pct(srv, 50) < 100 : null, 'Server-Timing');
  }

  if (WRITE) {
    const { statuses } = await (await fetch(BASE + '/api/apartments/status')).json();
    const no = Object.entries(statuses).find(([, s]) => (s?.status ?? s) === 'free')?.[0];
    const t0 = Date.now();
    const hold = await fetch(BASE + '/api/bookings/hold', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID(), Origin: BASE },
      body: JSON.stringify({ apartmentNo: Number(no), name: 'Bench Тест', phone: `+998 90 ${100 + crypto.randomInt(899)} ${10 + crypto.randomInt(89)} ${10 + crypto.randomInt(89)}`, lang: 'ru',
        consent: { version: '2026-10-27', privacy: true } }) });
    const h = await hold.json();
    if (!hold.ok) throw new Error(`hold → ${hold.status} ${h.error}`);
    const ref = h.link.split('/').pop();
    const xs = await series(`/api/bookings/by-ref/${ref}`, 50);
    row('PERF-06', 'GET /api/bookings/by-ref/:ref', 'p95 < 300 мс', `p50 ${ms(pct(xs, 50))} · p95 ${ms(pct(xs, 95))}`, pct(xs, 95) < 300);
    if (loggedIn) {
      // PERF-07: the dashboard polls the feed every 3 s (13 §10); from the hold to the line in the feed
      let seen = NaN;
      for (let i = 0; i < 10 && Number.isNaN(seen); i++) {
        const feed = await (await fetch(BASE + '/api/dashboard/feed?limit=20', staff())).json();
        if (feed.items?.some(e => e.type === 'booking.held' && Date.parse(e.at) >= t0 - 2000)) seen = Date.now() - t0;
        else await sleep(3000);
      }
      row('PERF-07', 'Событие на дашборде (опрос 3 с)', '< 5 с', sec(seen), seen < 5000, 'худший случай ≈ 3 с + ответ');
    }
    await fetch(BASE + `/api/bookings/by-ref/${ref}/release`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: '{}' });
  }

  if (TG) {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    const xs = [];
    for (let i = 0; i < 20; i++) {
      // an update kind the bot ignores: the answer time is the whole point, no message goes anywhere
      const r = await timed('/api/telegram/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
        body: JSON.stringify({ update_id: 900_000_000 + crypto.randomInt(99_000_000), poll: { id: 'bench', question: 'bench', options: [] } }) });
      if (r.status === 401) break;                                 // the local secret is not the one of that server
      if (r.status !== 200) throw new Error(`webhook → ${r.status}`);
      xs.push(r.ms);
    }
    if (xs.length) row('PERF-05', 'Ответ вебхуку Telegram', 'p95 < 500 мс', `p50 ${ms(pct(xs, 50))} · p95 ${ms(pct(xs, 95))}`, pct(xs, 95) < 500);
    else row('PERF-05', 'Ответ вебхуку Telegram', 'p95 < 500 мс', '—', null, '401: TELEGRAM_WEBHOOK_SECRET не тот, что на сервере');
  }

  if (CHAT > 0) {
    const qs = JSON.parse(fs.readFileSync(new URL('../eval/agents-control.json', import.meta.url), 'utf8')).slice(0, CHAT);
    const first = [], texts = [], full = [];
    let failed = 0;
    for (const [i, q] of qs.entries()) {
      try {
        const r = await ask(q.q, q.lang);
        if (r.failed) failed++;
        else { first.push(r.first); texts.push(r.text); full.push(r.done); }
        process.stdout.write(`  ${q.id}: ${r.failed ? 'error event' : `${ms(r.first)} / ${ms(r.text)} / ${ms(r.done)}`}\n`);
      } catch (e) { failed++; console.warn(`  ${q.id}: ${e.message}`); }
      if (i < qs.length - 1) await sleep(4000);                   // the free model tier counts requests per minute
    }
    row('PERF-03', `Первое видимое событие чата (${first.length} ответов${failed ? `, ${failed} ошибок` : ''})`, 'медиана < 2 с', sec(pct(first, 50)), pct(first, 50) < 2000, 'status «Думаю…»');
    row('PERF-03', 'Первый текст ответа', '—', `${sec(pct(texts, 50))} (p95 ${sec(pct(texts, 95))})`, null, 'для сведения');
    row('PERF-04', 'Полный ответ чата', 'медиана < 8 с', `${sec(pct(full, 50))} (p95 ${sec(pct(full, 95))})`, pct(full, 50) < 8000);
  }

  console.log(`\n| NFR | Что | Цель | Значение | ✓ | Примечание |\n|---|---|---|---|---|---|`);
  for (const r of rows) console.log(`| ${r.id} | ${r.what} | ${r.goal} | ${r.value} | ${r.ok == null ? '—' : r.ok ? '✓' : '✗'} | ${r.note} |`);
}

main().catch(e => { console.error('bench failed:', e.message); process.exit(1); });
