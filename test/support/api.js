// A test app with the booking and payment entries over a PGlite base (15 §6.1): the same order of parsers as server.js.
import express from 'express';
import crypto from 'node:crypto';
import { mountBookings } from '../../server/http/bookings.js';
import { mountPayments } from '../../server/http/payments.js';
import { requestId, noStore, apiErrors } from '../../server/http/common.js';

export const ENV = { LINK_SECRET: 'test-secret', SESSION_SECRET: 'test-session', PUBLIC_URL: 'https://domus.test', LOG_SALT: 'salt' };

export async function startApi(db, opts = {}) {
  const app = express();
  app.use(requestId);
  app.use('/api', noStore);
  mountBookings(app, db, { env: ENV, ...opts });
  mountPayments(app, db, { env: ENV, ...opts });
  app.use(express.json({ limit: '4mb' }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));
  app.use(apiErrors);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  // call('POST', '/api/…', body, { key, headers }) → { status, body, headers }
  const call = async (method, url, body, { key, headers = {} } = {}) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json',
      ...(key === undefined && method === 'POST' ? { 'idempotency-key': crypto.randomUUID() } : key ? { 'idempotency-key': key } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, body: json, text, headers: r.headers };
  };
  return { call, base, close: () => server.close() };
}
