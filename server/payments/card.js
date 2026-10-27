// The UzCard / HUMO emulator (05 §4, D-18): only test cards, an SMS code, no money moves. The code goes back to the
// browser as a pop-up «SMS» (the bank's part of the play); the base keeps only its hash.
import crypto from 'node:crypto';
import { fakeRef } from './index.js';
import { checkCard } from './testCards.js';
import { DomainError } from '../core/errors.js';
import { context, inTx } from '../core/tx.js';
import { markProcessing, markSucceeded, markFailed } from '../core/payments.js';
import { bookingPath } from '../core/links.js';
import { failureText } from '../i18n/index.js';

const CODE_MS = 5 * 60e3;
const MAX_ATTEMPTS = 3;
const FINAL_PAID = ['succeeded', 'refund_due', 'refunded'];

export function cardProvider() {
  return {
    id: 'card',
    label: { ru: 'UzCard / HUMO', uz: 'UzCard / HUMO', en: 'UzCard / HUMO' },
    mode: () => 'emulator',
    enabled: () => true,
    money: amount => ({ currency: 'UZS', providerAmount: amount }),
    begin: async (payment, { origin = '' } = {}) => ({ url: `${origin}/pay/card/${payment.id}` }),
    close: async () => 'closed',
    refund: async () => ({ status: 'succeeded', providerRef: fakeRef('rf') }),
    inspect: async payment => ({ state: inspectByBase(payment) })
  };
}

// The emulators keep everything in our base (05 §2.3 «inspect — по базе»).
export function inspectByBase(payment) {
  if (FINAL_PAID.includes(payment.status)) return 'paid';
  if (['pending', 'processing'].includes(payment.status)) return 'open';
  return 'closed';
}

const hashOf = (code, paymentId) => crypto.createHash('sha256').update(code + paymentId).digest('hex');
const sum = n => Number(n).toLocaleString('ru-RU').replace(/\s/g, ' ');
const live = (b, at) => b?.status === 'held' && b.expires_at > at;

// The closed payment as err:payment_closed carries it: the status and the reason.
const closedError = p => new DomainError('payment_closed', { status: p.status, reason: p.failure_reason });

async function lockPayment(q, id, provider) {
  const p = await q.one('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [id]);
  if (!p || p.provider !== provider) throw new DomainError('payment_not_found');
  return p;
}

// Step 1 (05 §4.3; Click emulator §5.7 step 1): { paymentId, number, expiry } → { sms, codeExpiresAt, brand, mask }.
// Form errors (422) leave the payment as it was. provider 'card' moves the payment to processing; 'click' keeps it
// pending — by the protocol the merchant knows nothing before Prepare.
export async function submitCard(db, { paymentId, number, expiry }, opts = {}, provider = 'card') {
  const ctx = context(opts);
  const out = await inTx(db, ctx, async (q, fx) => {
    const at = ctx.now();
    const p = await lockPayment(q, paymentId, provider);                                         // 1
    if (!['pending', 'processing'].includes(p.status)) throw closedError(p);                     // 2
    const checked = checkCard({ number, expiry }, at);                                           // 3–5
    if (checked.error) throw new DomainError(checked.error);
    const b = await q.one('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [p.booking_id]);   // 6
    if (!live(b, at)) return { closed: await markFailed(q, fx, ctx, { paymentId: p.id, reason: 'hold_expired' }) };
    const { brand, mask, scenario } = checked.card;
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = new Date(Math.min(at.getTime() + CODE_MS, b.expires_at.getTime()));
    await q.query(`INSERT INTO payment_challenges (payment_id, code_hash, attempts, scenario, card_brand, card_mask, expires_at, created_at)
      VALUES ($1, $2, 0, $3, $4, $5, $6, $7)
      ON CONFLICT (payment_id) DO UPDATE SET code_hash = EXCLUDED.code_hash, attempts = 0, scenario = EXCLUDED.scenario,
        card_brand = EXCLUDED.card_brand, card_mask = EXCLUDED.card_mask, expires_at = EXCLUDED.expires_at, created_at = EXCLUDED.created_at`,
    [p.id, hashOf(code, p.id), scenario, brand, mask, expiresAt, at]);
    if (provider === 'card') await markProcessing(q, fx, ctx, { paymentId: p.id, cardBrand: brand, cardMask: mask });
    return {
      sms: { from: '900', text: `Kod: ${code}. Hech kimga aytmang. Summa ${sum(p.amount)} so‘m`, code },
      codeExpiresAt: expiresAt.toISOString(), brand, mask
    };
  });
  if (out.closed) throw closedError(out.closed);                                                 // after COMMIT: the failure stays
  return out;
}

// Steps 2–3 of 05 §4.4 inside the caller's transaction, for the card and the Click emulator.
// → { ok: true, challenge } | { failed: row } | { wrong: attemptsLeft }.
export async function checkCode(q, fx, ctx, p, code) {
  const at = ctx.now();
  const ch = await q.one('SELECT * FROM payment_challenges WHERE payment_id = $1 FOR UPDATE', [p.id]);
  if (!ch || ch.expires_at <= at) return { failed: await markFailed(q, fx, ctx, { paymentId: p.id, reason: 'session_expired' }) };
  const want = Buffer.from(ch.code_hash);
  const got = Buffer.from(hashOf(String(code ?? ''), p.id));
  if (want.length === got.length && crypto.timingSafeEqual(want, got)) return { ok: true, challenge: ch };
  if (ch.attempts + 1 >= MAX_ATTEMPTS) return { failed: await markFailed(q, fx, ctx, { paymentId: p.id, reason: 'code_attempts_exceeded' }) };
  await q.query('UPDATE payment_challenges SET attempts = attempts + 1 WHERE payment_id = $1', [p.id]);
  return { wrong: MAX_ATTEMPTS - ch.attempts - 1 };
}

// The answer of the confirm step: the status, the reason and where the page goes next.
export async function resultOf(q, p, lang, env) {
  const b = await q.one('SELECT * FROM bookings WHERE id = $1', [p.booking_id]);
  const link = b ? bookingPath(b, env) : null;
  return {
    status: p.status, failureReason: p.failure_reason ?? null, failureText: failureText(p.failure_reason, lang),
    redirect: link && (p.status === 'succeeded' ? `${link}?paid=1` : link)
  };
}

// Step 2 (05 §4.4): { paymentId, code, lang } → { status, failureReason?, failureText?, redirect } | err:wrong_code {left}.
export async function confirmCard(db, { paymentId, code, lang = 'ru' }, opts = {}) {
  const ctx = context(opts);
  const out = await inTx(db, ctx, async (q, fx) => {
    const at = ctx.now();
    let p = await lockPayment(q, paymentId, 'card');                                             // 1
    if (p.status === 'succeeded') return resultOf(q, p, lang, ctx.env);
    if (p.status !== 'processing' && p.status !== 'pending') throw closedError(p);
    const c = await checkCode(q, fx, ctx, p, code);                                              // 2–3
    if (c.wrong != null) return { wrong: c.wrong };
    if (c.failed) return resultOf(q, c.failed, lang, ctx.env);
    const b = await q.one('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [p.booking_id]);   // 4: before the «charge»
    if (!live(b, at)) p = await markFailed(q, fx, ctx, { paymentId: p.id, reason: 'hold_expired' });
    else if (c.challenge.scenario === 'success') {                                               // 5
      p = (await markSucceeded(q, fx, ctx, { paymentId: p.id, providerRef: fakeRef('card'),
        cardBrand: c.challenge.card_brand, cardMask: c.challenge.card_mask })).payment;
    } else p = await markFailed(q, fx, ctx, { paymentId: p.id, reason: c.challenge.scenario });
    return resultOf(q, p, lang, ctx.env);                                                        // 6: the challenge went with the status
  });
  if (out.wrong != null) throw new DomainError('wrong_code', { left: out.wrong });
  return out;
}
