// Calls to /api/admin/* (12 §2): the session cookie rides along, changes carry X-Requested-With (CSRF, 14 §2).
// A 401 means the session is over: the shell shows the sign-in form again.
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `HTTP ${status}`);
    this.status = status;
    this.code = body?.error || 'internal';
    this.vars = body?.vars || {};
  }
}

const outListeners = new Set();
export const onSignedOut = fn => outListeners.add(fn);

// opts — { method, body, key (Idempotency-Key: one per intention, 13 §1.3), lang }.
export async function api(path, { method = 'GET', body, key, lang } = {}) {
  const headers = { 'X-Requested-With': 'domus-admin' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = key;
  if (lang) headers['Accept-Language'] = lang;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new ApiError(res.status, data);
    if (res.status === 401 && path !== '/api/admin/login') outListeners.forEach(fn => fn());
    throw err;
  }
  return data;
}

export const newKey = () => crypto.randomUUID();
