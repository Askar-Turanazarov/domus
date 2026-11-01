// The second Gemini key: quota and key errors before the first byte move the request to it; the chain sees one provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGemini } from '../../server/ai/gemini.js';
import { createAi } from '../../server/ai/index.js';
import { AiError } from '../../server/ai/errors.js';
import { createQuota } from '../../server/ai/quota.js';
import { MODELS } from '../../server/ai/models.js';

const req = model => ({ model, cfg: {}, role: 'tools', system: 'S', messages: [{ role: 'user', parts: [{ type: 'text', text: 'x' }] }], tools: [], maxOutputTokens: 10 });
const chunk = text => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });
const http = (status, quotaId = '') => Object.assign(new Error(`got status: ${status} ${JSON.stringify({ error: { details: [{ violations: [{ quotaId }] }] } })}`), { status });

// A fake client: each step is an error to throw or the text of an answer. The last step repeats.
function fake(steps = ['ok']) {
  const c = {
    calls: 0,
    embeds: 0,
    models: {
      async generateContentStream() {
        const s = steps[Math.min(c.calls++, steps.length - 1)];
        if (s instanceof Error) throw s;
        return (async function* () { yield chunk(s); })();
      },
      async embedContent() {
        const s = steps[Math.min(c.embeds++, steps.length - 1)];
        if (s instanceof Error) throw s;
        return { embeddings: [{ values: [3, 4] }] };
      }
    }
  };
  return c;
}

const text = r => r.parts.map(p => p.text).join('');

test('429 on the first key → the same model answers under the second', async () => {
  const a = fake([http(429)]), b = fake(['from b']);
  const r = await createGemini({ client: a, backupClient: b }).call(req('m'));
  assert.equal(text(r), 'from b');
  assert.deepEqual([a.calls, b.calls], [1, 1]);
});

test('an exhausted key is not asked again until its wait ends; other models still use it', async () => {
  let t = Date.parse('2026-11-02T04:00:00Z');
  const a = fake([http(429), 'a again']), b = fake(['from b']);
  const g = createGemini({ client: a, backupClient: b, now: () => new Date(t) });
  await g.call(req('m'));
  await g.call(req('m'));
  assert.deepEqual([a.calls, b.calls], [1, 2], 'second call skipped the cooling key');
  assert.equal(text(await g.call(req('other'))), 'a again', 'the wait is per model');
  t += 61_000;
  await g.call(req('m'));
  assert.equal(a.calls, 3, 'back after the minute');
});

test('a day quota waits for the Pacific midnight', async () => {
  let t = Date.parse('2026-11-02T04:00:00Z');
  const a = fake([http(429, 'GenerateRequestsPerDay')]), b = fake(['from b']);
  const g = createGemini({ client: a, backupClient: b, now: () => new Date(t) });
  await g.call(req('m'));
  t += 3 * 3600e3;
  await g.call(req('m'));
  assert.equal(a.calls, 1);
});

test('a rejected key is out for every model', async () => {
  const a = fake([http(403)]), b = fake(['from b']);
  const g = createGemini({ client: a, backupClient: b });
  await g.call(req('m'));
  await g.call(req('other'));
  assert.deepEqual([a.calls, b.calls], [1, 2]);
});

test('overload belongs to the model: no switch of key, the chain decides', async () => {
  const a = fake([http(503)]), b = fake(['from b']);
  await assert.rejects(createGemini({ client: a, backupClient: b }).call(req('m')), e => e.cls === 'overloaded');
  assert.equal(b.calls, 0);
});

test('both keys out → the error reaches the chain; then no requests at all', async () => {
  const a = fake([http(429)]), b = fake([http(429)]);
  const g = createGemini({ client: a, backupClient: b });
  await assert.rejects(g.call(req('m')), e => e instanceof AiError && e.cls === 'rate_minute');
  await assert.rejects(g.call(req('m')), e => e.cls === 'rate_minute');
  assert.deepEqual([a.calls, b.calls], [1, 1]);
});

test('an error after the first chunk stays with this attempt: the text must not be written twice', async () => {
  const a = { models: { async generateContentStream() { return (async function* () { yield chunk('half'); throw http(429); })(); } } };
  const b = fake(['from b']);
  await assert.rejects(createGemini({ client: a, backupClient: b }).call(req('m')), e => e.cls === 'rate_minute');
  assert.equal(b.calls, 0);
});

test('embeddings follow the same keys', async () => {
  const a = fake([http(429)]), b = fake(['ok']);
  const r = await createGemini({ client: a, backupClient: b }).embed({ model: 'e', texts: ['x'], dims: 2 });
  assert.deepEqual(r.vectors, [[0.6, 0.8]]);
});

test('one key: the error goes to the chain as before, nothing is remembered', async () => {
  const a = fake([http(429), 'ok']);
  const g = createGemini({ client: a });
  await assert.rejects(g.call(req('m')), e => e.cls === 'rate_minute');
  assert.equal(text(await g.call(req('m'))), 'ok');
});

test('createAi: the backup key comes from GEMINI_API_KEY_2 and never reaches the answer', async () => {
  const ai = createAi({ env: { GEMINI_API_KEY: 'k1', GEMINI_API_KEY_2: 'k2' } });
  assert.ok(ai.adapters.gemini);
  assert.equal(JSON.stringify(ai.adapters.gemini).includes('k2'), false);
});

test('the guard counts the quota of both keys: the first key running out does not stop the model', async () => {
  const at = new Date('2026-11-02T04:00:00Z');
  const cfg = MODELS['gemini-3.8-flash'];
  const db = { one: async () => ({ minute: 0, day: cfg.rpd }) };
  assert.equal((await createQuota({ db, now: () => at }).guard('gemini-3.8-flash')).reason, 'rate_day');
  assert.equal(await createQuota({ db, now: () => at, keys: 2 }).guard('gemini-3.8-flash'), null);
  const full = { one: async () => ({ minute: 0, day: cfg.rpd * 2 }) };
  assert.equal((await createQuota({ db: full, now: () => at, keys: 2 }).guard('gemini-3.8-flash')).reason, 'rate_day');
});

test('both keys failed differently: the chain gets the error of the key that returns first', async () => {
  const cases = [
    [http(429), http(429, 'GenerateRequestsPerDay'), 'rate_minute'],
    [http(429, 'GenerateRequestsPerDay'), http(429), 'rate_minute'],
    [http(429), http(403), 'rate_minute'],
    [http(403), http(429, 'GenerateRequestsPerDay'), 'rate_day'],
    [http(429), http(404), 'rate_minute'],
    [http(403), http(404), 'not_found'],
    [http(403), http(403), 'auth'],
    [http(404), http(404), 'not_found']
  ];
  for (const [ea, eb, cls] of cases) {
    const g = createGemini({ client: fake([ea]), backupClient: fake([eb]) });
    await assert.rejects(g.call(req('m')), e => e.cls === cls, `${ea.status} + ${eb.status} → ${cls}`);
  }
});

test('the minute wait the chain gets is what is left of it, also when the key was already cooling', async () => {
  let t = Date.parse('2026-11-02T04:00:00Z');
  const a = fake([http(429), 'ok']), b = fake(['ok', http(429, 'GenerateRequestsPerDay')]);
  const g = createGemini({ client: a, backupClient: b, now: () => new Date(t) });
  await g.call(req('m'));
  t += 50_000;
  await assert.rejects(g.call(req('m')), e => e.cls === 'rate_minute' && e.retryMs === 10_000);
  t += 11_000;
  assert.equal(text(await g.call(req('m'))), 'ok', 'the first key is back');
});

test('a model missing under the first key still answers under the second', async () => {
  const a = fake([http(404)]), b = fake(['from b']);
  assert.equal(text(await createGemini({ client: a, backupClient: b }).call(req('m'))), 'from b');
});
