// Error classes of the AI layer (06 §8.1) and how each provider's errors map onto them (§8.2, §8.3). Pure.
export class AiError extends Error {
  // cls — ai_calls.error_class; status — HTTP code or null; retryMs — the provider's own wait, if it gave one.
  constructor(cls, { status = null, retryMs = null, reason = null } = {}) {
    super(`ai:${cls}`);
    this.cls = cls;
    this.status = status;
    this.retryMs = retryMs;
    this.reason = reason;
  }
}

// '37s' / '1.5s' → ms
const seconds = s => {
  const m = /^(\d+(?:\.\d+)?)s$/.exec(String(s || ''));
  return m ? Math.round(Number(m[1]) * 1000) : null;
};

const NET = /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|TLS|network/i;

// The JSON body Google puts into ApiError.message («got status: 429 … {"error":{…}}»).
function googleBody(e) {
  const s = String(e?.message || '');
  const i = s.indexOf('{');
  if (i < 0) return {};
  try { return JSON.parse(s.slice(i)).error || {}; } catch { return {}; }
}

export function classifyGemini(e) {
  if (e instanceof AiError) return e;
  const status = Number(e?.status) || null;
  if (!status) return new AiError(NET.test(e?.message || e?.cause?.code || '') ? 'network' : 'server');
  const body = googleBody(e);
  const text = `${body.status || ''} ${body.message || e.message || ''}`;
  const details = Array.isArray(body.details) ? body.details : [];
  if (status === 429 || body.status === 'RESOURCE_EXHAUSTED') {
    const ids = details.flatMap(d => d.violations || []).map(v => String(v.quotaId || ''));
    const retryMs = seconds(details.find(d => 'retryDelay' in d)?.retryDelay);
    // An unclear 429 is a minute: the safe guess (§8.2).
    return new AiError(ids.some(id => /PerDay/i.test(id)) ? 'rate_day' : 'rate_minute', { status: 429, retryMs });
  }
  if (status === 503) return new AiError('overloaded', { status });
  if (status === 504) return new AiError('timeout', { status });
  if (status >= 500) return new AiError('server', { status });
  if (status === 401 || status === 403) return new AiError('auth', { status });
  if (status === 404) return new AiError('not_found', { status });
  if (status === 400 && (/API key not valid/i.test(text) || body.status === 'FAILED_PRECONDITION')) {
    return new AiError('auth', { status, reason: body.status === 'FAILED_PRECONDITION' ? 'region' : 'key' });
  }
  return new AiError('bad_request', { status });
}

const header = (h, name) => (typeof h?.get === 'function' ? h.get(name) : h?.[name]) ?? null;

export function classifyAnthropic(e) {
  if (e instanceof AiError) return e;
  const status = Number(e?.status) || null;
  const name = e?.constructor?.name || e?.name || '';
  if (/Timeout/.test(name)) return new AiError('timeout');
  if (!status) return new AiError(/Connection/.test(name) || NET.test(e?.message || '') ? 'network' : 'server');
  const type = e?.error?.error?.type || e?.error?.type || '';
  const text = String(e?.error?.error?.message || e?.message || '');
  if (status === 429 || type === 'rate_limit_error') {
    const ra = Number(header(e.headers, 'retry-after'));
    return new AiError('rate_minute', { status, retryMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : null });
  }
  if (status === 529 || type === 'overloaded_error') return new AiError('overloaded', { status });
  if (status >= 500) return new AiError('server', { status });
  if (status === 401 || status === 403) return new AiError('auth', { status });
  if (status === 404) return new AiError('not_found', { status });
  if (status === 400 && /credit balance|spend(ing)? limit|billing/i.test(text)) return new AiError('billing', { status });
  return new AiError('bad_request', { status });
}
