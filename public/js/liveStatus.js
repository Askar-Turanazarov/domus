// Live statuses of the showcase (11 §3.2): the page asks GET /api/apartments/status every 10 s while it is visible,
// at once when it becomes visible again and after the visitor's own actions. Only the apartments whose status changed
// are recoloured. Without an answer the data stays as it was and the page says how old it is (11 §12).
export const POLL_MS = 10_000;

// { 41: 'free', … } × { 41: 'held', … } → [[41, 'held'], …]: what differs, in apartment order.
export function diff(prev, next) {
  const out = [];
  for (const [no, st] of Object.entries(next ?? {})) if (prev?.[no] !== st) out.push([Number(no), st]);
  return out.sort((a, b) => a[0] - b[0]);
}

// Facade cells <span class="bld-cell st-free" data-apt="41">: swap the status class and the status in the title.
// → how many cells were touched (a cell that already has the class is left alone).
export function recolorCells(root, changes, statusText) {
  let touched = 0;
  for (const [no, st] of changes) {
    for (const cell of root.querySelectorAll(`[data-apt="${no}"]`)) {
      if (cell.classList.contains('st-' + st)) continue;
      for (const c of [...cell.classList]) if (c.startsWith('st-')) cell.classList.remove(c);
      cell.classList.add('st-' + st);
      const parts = (cell.title ?? '').split(' · ');
      if (parts.length > 1) { parts[parts.length - 1] = statusText(st); cell.title = parts.join(' · '); }
      touched++;
    }
  }
  return touched;
}

// "Updated N min ago" appears when the last good answer is older than two polls; null while it is fresh.
export function staleMinutes(lastOkMs, nowMs, pollMs = POLL_MS) {
  const age = nowMs - lastOkMs;
  return age > 2 * pollMs ? Math.max(1, Math.round(age / 60_000)) : null;
}

// env: { fetch, now, doc (visibility + events), setTimeout, clearTimeout } — all replaceable in a test.
// onUpdate({ statuses, mine, changes, at }) on every good answer (changes is empty when nothing differs);
// onStale(minutes | null) whenever the freshness changes.
export function createLiveStatus({ onUpdate, onStale = () => {}, url = '/api/apartments/status', pollMs = POLL_MS, env = {} }) {
  const fetchFn = env.fetch ?? ((...a) => fetch(...a));
  const now = env.now ?? (() => Date.now());
  const doc = env.doc ?? document;
  const later = env.setTimeout ?? setTimeout, cancel = env.clearTimeout ?? clearTimeout;
  let current = null, lastOk = null, timer = null, running = false, inflight = null, staleNow = null;

  const report = () => {
    const m = lastOk == null ? null : staleMinutes(lastOk, now(), pollMs);
    if (m !== staleNow) { staleNow = m; onStale(m); }
  };

  async function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const res = await fetchFn(url, { cache: 'no-store' });
        if (!res.ok) throw new Error(res.status);
        const data = await res.json();
        if (!data?.statuses) throw new Error('shape');
        const changes = diff(current, data.statuses);
        current = data.statuses;
        lastOk = now();
        report();
        onUpdate({ statuses: data.statuses, mine: data.mine ?? {}, changes, at: data.at, terms: data.terms });
        return true;
      } catch {
        report();
        return false;
      }
    })().finally(() => { inflight = null; });
    return inflight;
  }

  function schedule() {
    cancel(timer);
    timer = null;
    if (running && !doc.hidden) timer = later(async () => { await refresh(); schedule(); }, pollMs);
  }

  const onVisibility = () => {
    if (!running) return;
    if (doc.hidden) { cancel(timer); timer = null; return; }
    refresh().then(schedule);
  };
  doc.addEventListener('visibilitychange', onVisibility);

  return {
    // The first answer comes at once, the next ones every pollMs.
    start() { running = true; refresh().then(schedule); },
    stop() { running = false; cancel(timer); timer = null; doc.removeEventListener('visibilitychange', onVisibility); },
    // After the visitor's own action (a request sent, a hold refused, back from the payment page).
    refresh() { return refresh().then(() => { schedule(); }); },
    get statuses() { return current; }
  };
}
