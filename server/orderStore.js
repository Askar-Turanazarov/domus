// order.json storage: one write at a time (promise queue), each via a temp file + rename,
// so parallel orders never overwrite each other and a crash never leaves half a file.
import fs from 'node:fs/promises';
import path from 'node:path';

// empty() — the value of a missing file (a list of orders by default).
function createStore(file, empty = () => []) {
  let queue = Promise.resolve();

  async function read() {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return empty(); }
  }

  async function write(orders) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(orders, null, 2));
    await fs.rename(tmp, file);
  }

  // fn(orders) changes the list in place and returns a result; runs after every earlier update.
  function update(fn) {
    const run = queue.then(async () => {
      const orders = await read();
      const result = await fn(orders);
      await write(orders);
      return result;
    });
    queue = run.catch(() => {});
    return run;
  }

  return { read: () => queue.then(read), update };
}

// In-memory limit: at most `max` hits per key (IP) within `windowMs`.
function createRateLimit({ max = 5, windowMs = 10 * 60 * 1000, now = Date.now } = {}) {
  const hits = new Map();
  return function hit(key) {
    const t = now(), recent = (hits.get(key) || []).filter(x => t - x < windowMs);
    if (recent.length >= max) { hits.set(key, recent); return false; }
    recent.push(t);
    hits.set(key, recent);
    if (hits.size > 10000) for (const [k, v] of hits) if (!v.some(x => t - x < windowMs)) hits.delete(k);
    return true;
  };
}

export { createStore, createRateLimit };
