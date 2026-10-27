// The Claude adapter (06 §6, D-19): our format ↔ `messages`, the stream, stop reasons, tokens; errors → §8.3.
// The SDK is loaded lazily and only with ANTHROPIC_API_KEY; its own retries are off (maxRetries: 0, §8.3).
import { AiError, classifyAnthropic } from './errors.js';

async function defaultClient(apiKey) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  return new Anthropic({ apiKey, maxRetries: 0 });
}

// Our messages → Claude messages. This model's native blocks (thinking included) go back unchanged; our tool-call
// ids map onto Claude's toolu_… through native.ids, otherwise our own tc_<n> serve as tool_use ids. Pure.
export function toMessages(messages, model) {
  const out = [];
  let ids = {};
  const push = (role, content) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...content); else out.push({ role, content: [...content] });
  };
  for (const m of messages) {
    if (m.role === 'user') push('user', m.parts.filter(p => p.type === 'text').map(p => ({ type: 'text', text: p.text })));
    else if (m.role === 'assistant') {
      if (m.native?.provider === 'anthropic' && m.native.model === model) { ids = m.native.ids || {}; push('assistant', m.native.content); }
      else {
        ids = {};
        push('assistant', m.parts.filter(p => p.type !== 'text' || p.text).map(p => (p.type === 'tool_call'
          ? { type: 'tool_use', id: p.id, name: p.name, input: p.args ?? {} } : { type: 'text', text: p.text })));
      }
    } else if (m.role === 'tool') {
      push('user', m.parts.map(p => ({ type: 'tool_result', tool_use_id: ids[p.id] || p.id, content: JSON.stringify(p.result ?? null),
        ...(p.isError ? { is_error: true } : {}) })));
    }
  }
  return out;
}

export function requestOf({ model, cfg, system, messages, tools, output, maxOutputTokens }) {
  const params = {
    model,
    max_tokens: maxOutputTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: toMessages(messages, model),
    output_config: { effort: 'low' }
  };
  // Sonnet 5.5 refuses 'disabled' (400); a model without a thinking mode of its own gets no field at all (§6).
  if (cfg.thinking) params.thinking = { type: cfg.thinking };
  if (tools?.length) {
    params.tools = tools.map((t, i) => ({ name: t.name, description: t.description, input_schema: t.schema, strict: true,
      ...(i === tools.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}) }));
    params.tool_choice = { type: 'auto' };
  }
  if (output) params.output_config.format = { type: 'json_schema', schema: output.schema };
  return params;
}

export function createAnthropic({ apiKey, client = null } = {}) {
  let api = client;
  return {
    provider: 'anthropic',
    async call(req, { onEvent = () => {}, signal, tick = () => {}, firstId = 1 } = {}) {
      api ??= await defaultClient(apiKey);
      const params = requestOf(req);
      let msg;
      try {
        const stream = api.messages.stream(params, { signal });
        for await (const ev of stream) {
          tick();
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && !req.output) onEvent({ type: 'text', delta: ev.delta.text });
        }
        msg = await stream.finalMessage();
      } catch (e) {
        if (signal?.aborted) throw signal.reason ?? e;
        throw classifyAnthropic(e);
      }
      const u = msg.usage || {};
      const usage = {
        input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
        output: u.output_tokens || 0,
        cached: u.cache_read_input_tokens || 0,
        cacheWrite: u.cache_creation_input_tokens || 0
      };
      // Order matters (§6): the stop reason first — a refusal's content is not read.
      if (msg.stop_reason === 'refusal') return { parts: [], stop: 'refusal', usage, native: null };
      const parts = [];
      const ids = {};
      let n = firstId;
      for (const b of msg.content || []) {
        if (b.type === 'text') parts.push({ type: 'text', text: b.text });
        else if (b.type === 'tool_use') {
          const id = `tc_${n++}`;
          ids[id] = b.id;
          parts.push({ type: 'tool_call', id, name: b.name, args: b.input ?? {} });
        }
      }
      const stop = msg.stop_reason === 'max_tokens' ? 'max_tokens' : msg.stop_reason === 'tool_use' ? 'tool_calls' : 'end';
      return { parts, stop, usage, native: { provider: 'anthropic', model: req.model, content: msg.content, ids } };
    },
    async embed() { throw new AiError('not_found'); }   // Anthropic has no embeddings (§13.2)
  };
}
