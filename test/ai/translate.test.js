// 06 §17: gemini.translate and anthropic.translate — our format ↔ the providers', native parts kept between steps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toContents, requestOf as geminiRequest, createGemini } from '../../server/ai/gemini.js';
import { toMessages, requestOf as claudeRequest, createAnthropic } from '../../server/ai/anthropic.js';
import { MODELS } from '../../server/ai/models.js';

const user = { role: 'user', parts: [{ type: 'text', text: 'Трёшка до 1 млрд' }] };
const call = { role: 'assistant', parts: [{ type: 'tool_call', id: 'tc_1', name: 'search_apartments', args: { rooms: 3 } }] };
const result = { role: 'tool', parts: [{ type: 'tool_result', id: 'tc_1', name: 'search_apartments', result: { total: 2 } }] };
const schema = { type: 'object', properties: { rooms: { type: 'integer' } }, additionalProperties: false };
const tools = [{ name: 'search_apartments', description: 'Search', schema }];

test('gemini: contents from our messages; a function response goes as role user', () => {
  assert.deepEqual(toContents([user, call, result], 'gemini-3.8-flash'), [
    { role: 'user', parts: [{ text: 'Трёшка до 1 млрд' }] },
    { role: 'model', parts: [{ functionCall: { name: 'search_apartments', args: { rooms: 3 } } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'search_apartments', response: { total: 2 } } }] }
  ]);
});

test('gemini: the native parts with thoughtSignature go back as they came — only to the same model', () => {
  const raw = [{ functionCall: { name: 'search_apartments', args: { rooms: 3 } }, thoughtSignature: 'sig==' }];
  const withNative = { ...call, native: { provider: 'gemini', model: 'gemini-3.8-flash', parts: raw } };
  assert.deepEqual(toContents([user, withNative, result], 'gemini-3.8-flash')[1].parts, raw);
  // Another model (fallback mid-turn, §10): the signature is dropped, the call rebuilt.
  assert.equal(toContents([user, withNative, result], 'gemini-3.6-flash')[1].parts[0].thoughtSignature, undefined);
});

test('gemini: request config — tools as parametersJsonSchema, AUTO, thinking level, JSON output only with a schema', () => {
  const r = geminiRequest({ model: 'gemini-3.8-flash', cfg: MODELS['gemini-3.8-flash'], role: 'tools', system: 'S', messages: [user], tools, maxOutputTokens: 1024 });
  assert.equal(r.config.systemInstruction, 'S');
  assert.deepEqual(r.config.tools[0].functionDeclarations[0].parametersJsonSchema, schema);
  assert.equal(r.config.toolConfig.functionCallingConfig.mode, 'AUTO');
  assert.equal(r.config.thinkingConfig.thinkingLevel, 'low', '3.8 Flash has no minimal');
  const b = geminiRequest({ model: 'gemini-3.6-flash', cfg: MODELS['gemini-3.6-flash'], role: 'tools', system: 'S', messages: [user], tools, maxOutputTokens: 1024 });
  assert.equal(b.config.thinkingConfig.thinkingLevel, 'minimal');
  assert.equal(r.config.temperature, undefined);
  assert.equal(r.config.responseMimeType, undefined);
  const f = geminiRequest({ model: 'gemini-3.5-flash-lite', cfg: MODELS['gemini-3.5-flash-lite'], role: 'fast', system: 'S', messages: [user], output: { schema }, maxOutputTokens: 200 });
  assert.equal(f.config.thinkingConfig.thinkingLevel, 'minimal');
  assert.equal(f.config.responseMimeType, 'application/json');
  assert.equal(f.config.tools, undefined);
});

// A fake @google/genai client: the stream is a list of chunks.
const genai = chunks => ({ models: { generateContentStream: async () => (async function* () { yield* chunks; })() } });

test('gemini: stream → text deltas, tool calls with our ids, tokens (thoughts count as output), native parts', async () => {
  const parts = [{ text: 'thinking…', thought: true }, { text: 'Нашёл ' }, { functionCall: { name: 'get_apartment', args: { no: 41 } }, thoughtSignature: 's' }];
  const g = createGemini({ client: genai([
    { candidates: [{ content: { parts: parts.slice(0, 2) } }] },
    { candidates: [{ content: { parts: parts.slice(2) }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 40, thoughtsTokenCount: 60, cachedContentTokenCount: 500 } }
  ]) });
  const deltas = [];
  const r = await g.call({ model: 'gemini-3.8-flash', cfg: MODELS['gemini-3.8-flash'], role: 'tools', system: 'S', messages: [user], tools },
    { onEvent: e => deltas.push(e.delta), firstId: 3 });
  assert.deepEqual(deltas, ['Нашёл ']);
  assert.equal(r.stop, 'tool_calls');
  assert.deepEqual(r.parts[1], { type: 'tool_call', id: 'tc_3', name: 'get_apartment', args: { no: 41 } });
  assert.deepEqual(r.usage, { input: 1000, output: 100, cached: 500 });
  assert.deepEqual(r.native.parts, parts);
});

test('gemini: finish reasons — SAFETY is a refusal with no content, MAX_TOKENS, MALFORMED_FUNCTION_CALL is an error', async () => {
  const run = finishReason => createGemini({ client: genai([{ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason }] }]) })
    .call({ model: 'm', cfg: {}, role: 'tools', system: '', messages: [user] });
  assert.deepEqual((await run('SAFETY')).parts, []);
  assert.equal((await run('SAFETY')).stop, 'refusal');
  assert.equal((await run('MAX_TOKENS')).stop, 'max_tokens');
  await assert.rejects(run('MALFORMED_FUNCTION_CALL'), e => e.cls === 'malformed');
});

test('claude: request — cache on system and the last tool, strict tools, auto choice, effort low, no temperature', () => {
  const r = claudeRequest({ model: 'claude-sonnet-5-5', cfg: MODELS['claude-sonnet-5-5'], system: 'S', messages: [user], tools: [...tools, { ...tools[0], name: 'b' }], maxOutputTokens: 1024 });
  assert.deepEqual(r.system, [{ type: 'text', text: 'S', cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(r.thinking, { type: 'between_tools' });
  assert.deepEqual(r.tool_choice, { type: 'auto' });
  assert.equal(r.tools[0].strict, true);
  assert.equal(r.tools[0].input_schema, schema);
  assert.equal(r.tools[0].cache_control, undefined);
  assert.deepEqual(r.tools[1].cache_control, { type: 'ephemeral' });
  assert.equal(r.output_config.effort, 'low');
  for (const k of ['temperature', 'top_p', 'top_k']) assert.equal(r[k], undefined);
  const h = claudeRequest({ model: 'claude-haiku-5-5', cfg: MODELS['claude-haiku-5-5'], system: 'S', messages: [user], output: { schema }, maxOutputTokens: 100 });
  assert.deepEqual(h.thinking, { type: 'disabled' });
  assert.deepEqual(h.output_config.format, { type: 'json_schema', schema });
  assert.equal(h.tools, undefined);
});

test('claude: thinking blocks go back unchanged; tool results point at Claude ids', () => {
  const content = [{ type: 'thinking', thinking: 'hmm', signature: 'x' }, { type: 'tool_use', id: 'toolu_9', name: 'search_apartments', input: { rooms: 3 } }];
  const native = { provider: 'anthropic', model: 'claude-sonnet-5-5', content, ids: { tc_1: 'toolu_9' } };
  const m = toMessages([user, { ...call, native }, result], 'claude-sonnet-5-5');
  assert.equal(m[1].content[0], content[0]);
  assert.deepEqual(m[2].content[0], { type: 'tool_result', tool_use_id: 'toolu_9', content: '{"total":2}' });
  // Without native (or for another model): our ids, rebuilt blocks.
  const plain = toMessages([user, { ...call, native }, result], 'claude-haiku-5-5');
  assert.deepEqual(plain[1].content[0], { type: 'tool_use', id: 'tc_1', name: 'search_apartments', input: { rooms: 3 } });
  assert.equal(plain[2].content[0].tool_use_id, 'tc_1');
});

const claudeClient = (final, events = []) => ({ messages: { stream: () => {
  const s = (async function* () { yield* events; })();
  s.finalMessage = async () => final;
  return s;
} } });

test('claude: stop reason first — refusal content is not read; tool_use → tool_calls; tokens with cache', async () => {
  const refusal = await createAnthropic({ client: claudeClient({ stop_reason: 'refusal', content: [{ type: 'text', text: 'no' }], usage: {} }) })
    .call({ model: 'claude-sonnet-5-5', cfg: MODELS['claude-sonnet-5-5'], system: '', messages: [user] });
  assert.equal(refusal.stop, 'refusal');
  assert.deepEqual(refusal.parts, []);
  const deltas = [];
  const r = await createAnthropic({ client: claudeClient({ stop_reason: 'tool_use',
    content: [{ type: 'thinking', thinking: 't' }, { type: 'text', text: 'Ищу' }, { type: 'tool_use', id: 'toolu_1', name: 'x', input: {} }],
    usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 20 } },
  [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Ищу' } }]) })
    .call({ model: 'claude-sonnet-5-5', cfg: MODELS['claude-sonnet-5-5'], system: '', messages: [user] }, { onEvent: e => deltas.push(e.delta) });
  assert.deepEqual(deltas, ['Ищу']);
  assert.equal(r.stop, 'tool_calls');
  assert.deepEqual(r.parts.map(p => p.type), ['text', 'tool_call']);
  assert.deepEqual(r.native.ids, { tc_1: 'toolu_1' });
  assert.deepEqual(r.usage, { input: 1000, output: 20, cached: 900, cacheWrite: 0 });
});
