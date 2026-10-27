// npm run ai:smoke (06 §17): one real request to every model of the chains with an «echo» tool, then the tool's
// answer back — the second step proves the native parts (thoughtSignature / thinking) are accepted. Spends cents.
// Prints model, tokens, ms, first byte; a provider without its key is skipped. Exit 1 if any model failed.
import { createAi } from '../server/ai/index.js';
import { CHAINS, MODELS, EMBED_MODEL, timeouts } from '../server/ai/models.js';

const ai = createAi();
const echo = { name: 'echo', description: 'Returns the given word. Call it once with the word the user asks for.',
  schema: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'], additionalProperties: false } };
let failed = 0;

for (const role of ['fast', 'tools']) {
  for (const model of CHAINS[role]) {
    const cfg = MODELS[model];
    const adapter = ai.adapters[cfg.provider];
    if (!adapter) { console.log(`${model.padEnd(24)} skip (no key)`); continue; }
    const t0 = performance.now();
    let first = null;
    try {
      const req = { model, cfg, role, system: 'You are a test. Follow the instruction exactly.', maxOutputTokens: 512, tools: [echo], output: null,
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'Call echo with the word "chinor", then answer with that word only.' }] }] };
      const lim = timeouts(role);
      const r1 = await adapter.call(req, { signal: AbortSignal.timeout(lim.totalMs * 2), tick: () => { first ??= performance.now() - t0; } });
      let r = r1;
      const call = r1.parts.find(p => p.type === 'tool_call');
      if (call) {
        req.messages = [...req.messages, { role: 'assistant', parts: r1.parts, native: r1.native },
          { role: 'tool', parts: [{ type: 'tool_result', id: call.id, name: call.name, result: { word: call.args.word } }] }];
        r = await adapter.call(req, { signal: AbortSignal.timeout(lim.totalMs * 2), firstId: 2 });
      }
      const text = r.parts.filter(p => p.type === 'text').map(p => p.text).join('').trim();
      console.log(`${model.padEnd(24)} ok   tool=${call ? 'yes' : 'NO'} stop=${r.stop} in=${r1.usage.input}+${r.usage.input} out=${r1.usage.output}+${r.usage.output} cached=${r.usage.cached} first=${Math.round(first)}ms total=${Math.round(performance.now() - t0)}ms «${text.slice(0, 40)}»`);
      if (!call) failed++;
    } catch (e) {
      failed++;
      console.log(`${model.padEnd(24)} FAIL ${e.cls || e.name} ${e.status || ''}`);
    }
  }
}

if (ai.adapters.gemini) {
  try {
    const { vectors } = await ai.embed({ texts: ['Когда сдача дома?'] });
    console.log(`${EMBED_MODEL.padEnd(24)} ok   dims=${vectors[0].length}`);
  } catch (e) { failed++; console.log(`${EMBED_MODEL.padEnd(24)} FAIL ${e.cls || e.name}`); }
}
process.exit(failed ? 1 : 0);
