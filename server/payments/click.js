// Click by the real SHOP API (05 §5): Prepare / Complete with the MD5 signature, the emulator page that calls them with
// real HTTP requests, the link to the live Click. The live mode is switched only by variables (FR-PAY-04).
import crypto from 'node:crypto';
import { fakeRef } from './index.js';
import { inspectByBase, submitCard, checkCode, resultOf } from './card.js';
import { DomainError } from '../core/errors.js';
import { context, inTx } from '../core/tx.js';
import { markProcessing, markSucceeded, markFailed } from '../core/payments.js';

const KEYS = ['CLICK_SERVICE_ID', 'CLICK_MERCHANT_ID', 'CLICK_MERCHANT_USER_ID', 'CLICK_SECRET_KEY'];
const EMULATOR = { CLICK_SERVICE_ID: '10000', CLICK_MERCHANT_ID: '20000', CLICK_MERCHANT_USER_ID: '30000', CLICK_SECRET_KEY: 'mock-click-secret-key' };
const TIMEOUT_MS = 10_000;

// The settings of 05 §5.2: in emulator mode the missing ones take the training values; in live mode none may be missing.
export function clickConfig(env = process.env) {
  const live = env.CLICK_MODE === 'live';
  const cfg = Object.fromEntries(KEYS.map(k => [k, env[k] || (live ? '' : EMULATOR[k])]));
  return { live, ...cfg, ok: KEYS.every(k => cfg[k]) };
}

export function clickProvider(env = process.env) {
  const cfg = clickConfig(env);
  return {
    id: 'click',
    label: { ru: 'Click', uz: 'Click', en: 'Click' },
    mode: () => (cfg.live ? 'live' : 'emulator'),
    enabled: () => cfg.ok,
    money: amount => ({ currency: 'UZS', providerAmount: amount }),
    begin: async (payment, { origin = '' } = {}) => {
      if (!cfg.live) return { url: `${origin}/pay/click/${payment.id}` };
      const q = new URLSearchParams({ service_id: cfg.CLICK_SERVICE_ID, merchant_id: cfg.CLICK_MERCHANT_ID,
        amount: Number(payment.amount).toFixed(2), transaction_param: payment.code,
        return_url: `${origin}/pay/return?payment=${payment.id}` });
      return { url: `https://my.click.uz/services/pay?${q}` };
    },
    close: async () => 'closed',                        // a later Complete gets −9 (§5.5 step 7)
    refund: async () => (cfg.live ? { status: 'failed', error: 'manual_required' } : { status: 'succeeded', providerRef: fakeRef('rf') }),
    inspect: async payment => ({ state: inspectByBase(payment) })
  };
}

// 05 §5.4: the values glued as they came, no separators.
export function clickSign(f, secret) {
  const parts = [f.click_trans_id, f.service_id, secret, f.merchant_trans_id];
  if (String(f.action) === '1') parts.push(f.merchant_prepare_id);
  parts.push(f.amount, f.action, f.sign_time);
  return crypto.createHash('md5').update(parts.map(v => String(v ?? '')).join('')).digest('hex');
}

const NOTE = {
  0: 'Success', [-1]: 'SIGN CHECK FAILED!', [-2]: 'Incorrect parameter amount', [-3]: 'Action not found', [-4]: 'Already paid',
  [-5]: 'User does not exist', [-6]: 'Transaction does not exist', [-8]: 'Error in request from click', [-9]: 'Transaction cancelled'
};
const REQUIRED = ['click_trans_id', 'service_id', 'click_paydoc_id', 'merchant_trans_id', 'amount', 'action', 'error', 'error_note',
  'sign_time', 'sign_string'];

function sameHex(a, b) {
  const x = Buffer.from(String(a).toLowerCase());
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Prepare (action 0) and Complete (action 1), 05 §5.5–5.6: one transaction, the answer is always a protocol JSON.
// body — the form as it came; action — what the route expects. → { click_trans_id, merchant_trans_id, …, error, error_note }.
export async function handleClick(db, body = {}, action, opts = {}) {
  const ctx = context(opts);
  const cfg = clickConfig(ctx.env);
  const idKey = action === 0 ? 'merchant_prepare_id' : 'merchant_confirm_id';
  const answer = (error, id = null) => ({ click_trans_id: body.click_trans_id ?? null, merchant_trans_id: body.merchant_trans_id ?? null,
    [idKey]: id, error, error_note: NOTE[error] });

  return inTx(db, ctx, async (q, fx) => {
    const at = ctx.now();
    let paymentId = null;
    const done = async (error, id = null) => {
      if (body.click_trans_id != null && body.action != null) {                                 // the log for the admin; repeats are not logged twice
        await q.query(`INSERT INTO provider_events (provider, event_id, type, payment_id, result, received_at)
          VALUES ('click', $1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [`${body.click_trans_id}:${body.action}`, action === 0 ? 'prepare' : 'complete', paymentId, String(error), at]);
      }
      return answer(error, id);
    };
    if (REQUIRED.some(k => body[k] == null || body[k] === '') || (String(body.action) === '1' && !body.merchant_prepare_id)) return done(-8);  // 1
    if (String(body.action) !== String(action)) return done(-3);                                                                // 2
    if (String(body.service_id) !== cfg.CLICK_SERVICE_ID || !sameHex(body.sign_string, clickSign(body, cfg.CLICK_SECRET_KEY))) return done(-1);  // 3
    const p = await q.one(`SELECT * FROM payments WHERE code = $1 AND provider = 'click' FOR UPDATE`, [String(body.merchant_trans_id)]);
    if (!p) return done(-5);                                                                                                   // 4
    paymentId = p.id;
    const amount = parseFloat(body.amount);
    if (!(Math.abs(amount - Number(p.amount)) <= 0.01)) return done(-2);                                                       // 5
    if (['succeeded', 'refund_due', 'refunded'].includes(p.status)) return done(-4);                                           // 6
    if (['failed', 'cancelled'].includes(p.status)) return done(-9);                                                           // 7
    const trans = String(body.click_trans_id);
    const holdAlive = async () => {
      const b = await q.one('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [p.booking_id]);
      return b?.status === 'held' && b.expires_at > at;
    };

    if (action === 0) {
      if (p.status === 'processing') return done(p.provider_ref === trans ? 0 : -9, p.provider_ref === trans ? Number(p.click_prepare_id) : null);  // 2, 3
      if (!(await holdAlive())) {                                                                                              // 4
        await markFailed(q, fx, ctx, { paymentId: p.id, reason: 'hold_expired' });
        return done(-9);
      }
      const { id } = await q.one(`SELECT nextval('click_prepare_seq')::int AS id`);                                            // 5
      await markProcessing(q, fx, ctx, { paymentId: p.id, providerRef: trans, clickPrepareId: id });
      return done(0, id);                                                                                                      // 6
    }

    if (p.status !== 'processing' || p.provider_ref !== trans || String(p.click_prepare_id) !== String(body.merchant_prepare_id)) return done(-6);  // 2
    if (Number(body.error) < 0) {                                                                                              // 3
      await markFailed(q, fx, ctx, { paymentId: p.id, reason: Number(body.error) === -5017 ? 'insufficient_funds' : 'bank_declined' });
      return done(-9);
    }
    if (!(await holdAlive())) {                                                                                                // 4: Click cancels the charge itself
      await markFailed(q, fx, ctx, { paymentId: p.id, reason: 'hold_expired' });
      return done(-9);
    }
    await markSucceeded(q, fx, ctx, { paymentId: p.id, providerRef: trans });                                                 // 5
    return done(0, Number(p.click_prepare_id));                                                                               // 6
  });
}

// ---- The emulator (05 §5.7) ----

const SCENARIO_ERROR = { success: 0, insufficient_funds: -5017, bank_declined: -5000 };

// Tashkent time 'YYYY-MM-DD HH:mm:ss' for sign_time.
const signTime = at => new Date(at.getTime() + 5 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');

// A signed request of Click to our merchant routes, as Click would form it.
export function clickRequest(payment, action, { clickTransId, paydocId, prepareId = null, error = 0, at }, env = process.env) {
  const cfg = clickConfig(env);
  const f = { click_trans_id: String(clickTransId), service_id: cfg.CLICK_SERVICE_ID, click_paydoc_id: String(paydocId),
    merchant_trans_id: payment.code, amount: Number(payment.amount).toFixed(2), action: String(action), error: String(error),
    error_note: error ? 'Error' : 'Success', sign_time: signTime(at) };
  if (action === 1) f.merchant_prepare_id = String(prepareId);
  return { ...f, sign_string: clickSign(f, cfg.CLICK_SECRET_KEY) };
}

// The transport of 05 §5.7: real HTTP to PUBLIC_URL by default; in process for tests and without PUBLIC_URL.
async function send(db, path, action, form, ctx) {
  const env = ctx.env;
  if (env.CLICK_EMULATOR_TRANSPORT === 'inprocess' || !env.PUBLIC_URL) return handleClick(db, form, action, ctx);
  const r = await fetch(`${env.PUBLIC_URL}/api/payments/click/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!r.ok) throw new Error(`click ${path}: HTTP ${r.status}`);
  return r.json();
}

// Step 1: card and expiry → the «SMS»; the payment stays pending.
export const submitClickCard = (db, input, opts = {}) => submitCard(db, input, opts, 'click');

// Steps 2–4: the code; when right — Prepare and Complete over the transport, then the result by the payment status.
export async function confirmClick(db, { paymentId, code, lang = 'ru' }, opts = {}) {
  const ctx = context(opts);
  const first = await inTx(db, ctx, async (q, fx) => {
    const p = await q.one(`SELECT * FROM payments WHERE id = $1 AND provider = 'click' FOR UPDATE`, [paymentId]);
    if (!p) throw new DomainError('payment_not_found');
    if (p.status === 'succeeded') return { result: await resultOf(q, p, lang, ctx.env) };
    if (p.status !== 'pending') throw new DomainError('payment_closed', { status: p.status, reason: p.failure_reason });
    const c = await checkCode(q, fx, ctx, p, code);
    if (c.wrong != null) return { wrong: c.wrong };
    if (c.failed) return { result: await resultOf(q, c.failed, lang, ctx.env) };
    await q.query('DELETE FROM payment_challenges WHERE payment_id = $1', [p.id]);   // one code — one charge
    return { payment: p, scenario: c.challenge.scenario };
  });
  if (first.wrong != null) throw new DomainError('wrong_code', { left: first.wrong });
  if (first.result) return first.result;

  const { payment, scenario } = first;
  const ids = { clickTransId: crypto.randomInt(100_000_000, 9_999_999_999), paydocId: crypto.randomInt(100_000_000, 9_999_999_999) };
  try {
    const prep = await send(db, 'prepare', 0, clickRequest(payment, 0, { ...ids, at: ctx.now() }, ctx.env), ctx);
    if (prep.error === 0) {
      await send(db, 'complete', 1, clickRequest(payment, 1,
        { ...ids, prepareId: prep.merchant_prepare_id, error: SCENARIO_ERROR[scenario], at: ctx.now() }, ctx.env), ctx);
    }
  } catch (e) {
    console.error('click emulator transport failed:', e.message);
  }
  return inTx(db, ctx, async (q, fx) => {
    let p = await q.one('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [payment.id]);
    if (['pending', 'processing'].includes(p.status)) p = await markFailed(q, fx, ctx, { paymentId: p.id, reason: 'provider_error' });
    return resultOf(q, p, lang, ctx.env);
  });
}
