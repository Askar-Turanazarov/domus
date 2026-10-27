// A QStash-signed request for POST /api/jobs/run (04 §6.4): an HS256 JWT over the body hash, as @upstash/qstash verifies it.
import crypto from 'node:crypto';

const b64 = v => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

export function qstashSignature(body, { key, url, at = new Date() }) {
  const sec = Math.floor(at.getTime() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const claims = b64({ iss: 'Upstash', sub: url, exp: sec + 300, nbf: sec - 60, iat: sec, jti: crypto.randomUUID(),
    body: crypto.createHash('sha256').update(body).digest('base64url') });
  const sig = crypto.createHmac('sha256', key).update(`${head}.${claims}`).digest('base64url');
  return `${head}.${claims}.${sig}`;
}
