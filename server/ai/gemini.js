// The Gemini adapter (06 §5): our message format ↔ `contents`, the stream, finish reasons, tokens; errors → §8.2.
// The raw `parts` of every answer (with thoughtSignature) go back as they came: `native` of the assistant message.
import { AiError, classifyGemini } from './errors.js';

let sdk = null;
async function defaultClient(apiKey) {
  sdk ??= await import('@google/genai');
  return new sdk.GoogleGenAI({ apiKey });
}

// Our messages (06 §2.2) → Gemini contents. An assistant message with this model's native parts sends them back
// untouched; another model's natives are dropped (§10) and the parts are rebuilt. Pure.
export function toContents(messages, model) {
  const out = [];
  const push = (role, parts) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts.push(...parts); else out.push({ role, parts: [...parts] });
  };
  for (const m of messages) {
    if (m.role === 'user') push('user', m.parts.filter(p => p.type === 'text').map(p => ({ text: p.text })));
    else if (m.role === 'assistant') {
      if (m.native?.provider === 'gemini' && m.native.model === model) push('model', m.native.parts);
      else push('model', m.parts.map(p => (p.type === 'tool_call' ? { functionCall: { name: p.name, args: p.args ?? {} } } : { text: p.text })));
    } else if (m.role === 'tool') {
      push('user', m.parts.map(p => ({ functionResponse: { name: p.name, response: p.isError ? { error: p.result } : p.result } })));
    }
  }
  return out;
}

export function requestOf({ model, cfg, role, system, messages, tools, output, maxOutputTokens }) {
  const config = {
    systemInstruction: system,
    maxOutputTokens,
    thinkingConfig: { thinkingLevel: role === 'fast' ? (cfg.thinkingLevel || 'low') : 'low' }
  };
  if (tools?.length) {
    config.tools = [{ functionDeclarations: tools.map(t => ({ name: t.name, description: t.description, parametersJsonSchema: t.schema })) }];
    config.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
  }
  if (output) { config.responseMimeType = 'application/json'; config.responseJsonSchema = output.schema; }
  return { model, contents: toContents(messages, model), config };
}

const REFUSAL = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY']);

// One model step. tick() — called on the first chunk (first byte); signal — our timeouts and the client's going away.
export function createGemini({ apiKey, client = null } = {}) {
  let ai = client;
  return {
    provider: 'gemini',
    async call(req, { onEvent = () => {}, signal, tick = () => {}, firstId = 1 } = {}) {
      ai ??= await defaultClient(apiKey);
      const params = requestOf(req);
      params.config.abortSignal = signal;
      const parts = [];
      const out = [];
      let finish = null, usage = {}, n = firstId;
      try {
        const stream = await ai.models.generateContentStream(params);
        for await (const chunk of stream) {
          tick();
          const cand = chunk.candidates?.[0];
          if (chunk.usageMetadata) usage = chunk.usageMetadata;
          if (cand?.finishReason) finish = cand.finishReason;
          for (const p of cand?.content?.parts || []) {
            parts.push(p);
            if (p.functionCall) out.push({ type: 'tool_call', id: `tc_${n++}`, name: p.functionCall.name, args: p.functionCall.args ?? {} });
            else if (typeof p.text === 'string' && !p.thought && p.text) {
              const last = out[out.length - 1];
              if (last?.type === 'text') last.text += p.text; else out.push({ type: 'text', text: p.text });
              if (!req.output) onEvent({ type: 'text', delta: p.text });
            }
          }
          if (chunk.promptFeedback?.blockReason) finish = 'SAFETY';
        }
      } catch (e) {
        if (signal?.aborted) throw signal.reason ?? e;
        throw classifyGemini(e);
      }
      if (finish === 'MALFORMED_FUNCTION_CALL') throw new AiError('malformed');
      const calls = out.some(p => p.type === 'tool_call');
      const stop = REFUSAL.has(finish) ? 'refusal' : finish === 'MAX_TOKENS' ? 'max_tokens' : calls ? 'tool_calls' : 'end';
      return {
        parts: stop === 'refusal' ? [] : out,
        stop,
        usage: {
          input: usage.promptTokenCount || 0,
          output: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
          cached: usage.cachedContentTokenCount || 0
        },
        native: { provider: 'gemini', model: req.model, parts }
      };
    },
    // 06 §13: one vector per text, 768 numbers, normalised here (the API does not at 768).
    async embed({ model, texts, taskType, dims }, { signal } = {}) {
      ai ??= await defaultClient(apiKey);
      try {
        const r = await ai.models.embedContent({ model, contents: texts, config: { taskType, outputDimensionality: dims, abortSignal: signal } });
        return { vectors: (r.embeddings || []).map(e => normalise(e.values || [])), usage: { input: 0, output: 0, cached: 0 } };
      } catch (e) {
        if (signal?.aborted) throw signal.reason ?? e;
        throw classifyGemini(e);
      }
    }
  };
}

export function normalise(v) {
  const len = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return len ? v.map(x => x / len) : v;
}
