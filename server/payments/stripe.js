// Stripe Checkout (05 §6, D-05): test mode only. The SDK is loaded lazily (01 §6): the emulators do not need it.
// opts.stripe — a client given by tests instead of the real one; the signature is always checked by the real library.
import { context, inTx } from '../core/tx.js';
import { markSucceeded, markFailed, cancelPayment, OPEN } from '../core/payments.js';
import { bookingPath } from '../core/links.js';
import { applyRefundResult } from '../core/refunds.js';

const SESSION_MIN = 31;                                    // Stripe takes no less than 30 minutes (§6.3)
const LOCALE = { ru: 'ru', en: 'en', uz: 'auto' };         // Stripe has no Uzbek
const NAME = {
  ru: (apt, no) => [`Депозит за бронь квартиры №${apt} — ЖК Chinor Park`, `Бронь №${no} · учебный проект Domus Estate`],
  uz: (apt, no) => [`№${apt} xonadonni bron qilish uchun depozit — Chinor Park TJM`, `Bron №${no} · Domus Estate o‘quv loyihasi`],
  en: (apt, no) => [`Deposit for apartment No. ${apt} — Chinor Park`, `Booking No. ${no} · Domus Estate training project`]
};

// 05 §6.1–6.2, 16 §5: the key must be a test one; sk_live_ turns Stripe off (14 §9).
export function stripeConfig(env = process.env) {
  const key = env.STRIPE_SECRET_KEY ?? '';
  const live = key.startsWith('sk_live_');
  const currency = (env.STRIPE_CURRENCY || 'uzs').toLowerCase();
  const rate = Number(env.STRIPE_USD_RATE);
  const moneyOk = currency === 'uzs' || (currency === 'usd' && rate > 0);
  return { key, secret: env.STRIPE_WEBHOOK_SECRET ?? '', live, currency, rate,
    ok: key.startsWith('sk_test_') && Boolean(env.STRIPE_WEBHOOK_SECRET) && moneyOk };
}

let warned = false;
const clients = new Map();
async function lib() {
  return (await import('stripe')).default;
}
async function clientOf(cfg, override) {
  if (override) return override;
  if (!clients.has(cfg.key)) clients.set(cfg.key, new (await lib())(cfg.key, { maxNetworkRetries: 2, timeout: 10_000 }));
  return clients.get(cfg.key);
}

// sum → the provider's units (§6.2): UZS is two-decimal at Stripe (×100); USD — cents by the training rate.
export function stripeMoney(amount, cfg) {
  if (cfg.currency === 'usd') return { currency: 'USD', providerAmount: Math.round(amount / cfg.rate * 100) };
  return { currency: 'UZS', providerAmount: amount * 100 };
}

// 'paid' | 'open' | 'closed' by a Checkout session.
const stateOf = s => (s.payment_status === 'paid' ? 'paid' : s.status === 'open' ? 'open' : 'closed');
const piOf = s => (typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent?.id) ?? null;

// The card brand and the last digits (§6.4, «желательно»): an error leaves them empty.
async function cardOf(client, pi) {
  if (!pi) return {};
  try {
    const intent = await client.paymentIntents.retrieve(pi, { expand: ['latest_charge'] });
    const card = intent.latest_charge?.payment_method_details?.card;
    return card ? { cardBrand: String(card.brand).toUpperCase(), cardMask: `•••• ${card.last4}` } : {};
  } catch (e) {
    console.error('stripe card details:', e.message);
    return {};
  }
}

// opts — { stripe?, now? } (getProvider passes the caller's context).
export function stripeProvider(env = process.env, opts = {}) {
  const cfg = stripeConfig(env);
  if (cfg.live && !warned) {
    warned = true;
    console.error('stripe: a live key (sk_live_) is set — Stripe is off, only test keys are allowed');
  }
  const client = () => clientOf(cfg, opts.stripe);
  const now = opts.now ?? context().now;
  return {
    id: 'stripe',
    label: { ru: 'Visa / Mastercard', uz: 'Visa / Mastercard', en: 'Visa / Mastercard' },
    mode: () => 'test',
    enabled: () => cfg.ok,
    money: amount => stripeMoney(amount, cfg),

    // §6.3. ctx — { lang, origin, booking: { no, apartment_no } }. → { url, ref: session id }.
    begin: async (payment, { lang = 'ru', origin = '', booking = {} } = {}) => {
      const [name, description] = (NAME[lang] ?? NAME.ru)(booking.apartment_no, booking.no);
      const back = `${origin}/pay/return?payment=${payment.id}`;
      const s = await (await client()).checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        client_reference_id: payment.id,
        locale: LOCALE[lang] ?? 'auto',
        line_items: [{ quantity: 1, price_data: { currency: String(payment.currency).toLowerCase(),
          unit_amount: Number(payment.provider_amount), product_data: { name, description } } }],
        metadata: { paymentId: payment.id, paymentCode: payment.code, kind: payment.kind, bookingNo: String(booking.no ?? '') },
        payment_intent_data: { description: `Domus Estate ${payment.code}`, metadata: { paymentId: payment.id, paymentCode: payment.code } },
        expires_at: Math.floor(now().getTime() / 1000) + SESSION_MIN * 60,
        success_url: `${back}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${back}&cancelled=1`
      }, { idempotencyKey: `checkout:${payment.id}` });
      return { url: s.url, ref: s.id };
    },

    // §6.6: expire the open session; a paid one → 'paid'. No session yet → 'gone'.
    close: async payment => {
      if (!payment.provider_ref) return 'gone';
      const c = await client();
      let s = await c.checkout.sessions.retrieve(payment.provider_ref);
      if (s.status === 'open') {
        try {
          s = await c.checkout.sessions.expire(payment.provider_ref);
        } catch (e) {                                       // paid in the very moment: look again
          s = await c.checkout.sessions.retrieve(payment.provider_ref);
          if (stateOf(s) !== 'paid') throw e;
        }
      }
      return stateOf(s) === 'paid' ? 'paid' : 'closed';
    },

    // → { state, refs: { providerRef, providerPaymentRef, cardBrand?, cardMask? } }.
    inspect: async payment => {
      if (!payment.provider_ref) return { state: 'unknown' };
      const c = await client();
      const s = await c.checkout.sessions.retrieve(payment.provider_ref);
      const state = stateOf(s);
      const refs = { providerRef: s.id, providerPaymentRef: piOf(s), ...(state === 'paid' ? await cardOf(c, piOf(s)) : {}) };
      return { state, refs };
    },

    // §8.2: the key of idempotency is the refund id — a repeat of the job makes no second refund.
    refund: async (payment, refund) => {
      const c = await client();
      const r = refund.provider_ref
        ? await c.refunds.retrieve(refund.provider_ref)
        : await c.refunds.create({ payment_intent: payment.provider_payment_ref, amount: Number(payment.provider_amount),
          reason: 'requested_by_customer', metadata: { refundId: refund.id, paymentCode: payment.code } },
        { idempotencyKey: `refund:${refund.id}` });
      const status = r.status === 'succeeded' ? 'succeeded' : ['failed', 'canceled'].includes(r.status) ? 'failed' : 'pending';
      return { status, providerRef: r.id, ...(status === 'failed' && { error: r.failure_reason ?? r.status }) };
    },

    cardOf: async pi => cardOf(await client(), pi)
  };
}

// ---- The webhook (§6.4) ----

const HANDLED = ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed',
  'checkout.session.expired'];

// raw — the body as it came (Buffer); signature — the stripe-signature header. → { status, body }.
export async function handleStripeWebhook(db, raw, signature, opts = {}) {
  const ctx = context(opts);
  const cfg = stripeConfig(ctx.env);
  if (!cfg.ok) return { status: 400, body: { error: 'stripe_off' } };
  let event;
  try {                                                                                          // 1
    event = (await lib()).webhooks.constructEvent(raw, signature ?? '', cfg.secret);
  } catch (e) {
    console.error('stripe_signature_invalid:', e.message);
    return { status: 400, body: { error: 'stripe_signature_invalid' } };
  }
  const obj = event.data?.object ?? {};
  const paid = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)
    && obj.payment_status === 'paid';
  const card = paid ? await stripeProvider(ctx.env, ctx).cardOf(piOf(obj)) : {};             // before the transaction

  return inTx(db, ctx, async (q, fx) => {
    const at = ctx.now();
    const fresh = await q.one(`INSERT INTO provider_events (provider, event_id, type, received_at)
      VALUES ('stripe', $1, $2, $3) ON CONFLICT DO NOTHING RETURNING 1 AS ok`, [event.id, event.type, at]);  // 2
    if (!fresh) return { status: 200, body: { duplicate: true } };
    const paymentId = HANDLED.includes(event.type) ? obj.metadata?.paymentId ?? obj.client_reference_id : null;
    const p = paymentId && await q.one(`SELECT * FROM payments WHERE id = $1 AND provider = 'stripe'`, [paymentId]);
    let result = 'ignored';                                                                      // 3
    if (HANDLED.includes(event.type) && !p) result = 'unknown_payment';
    else if (paid) {
      result = (await markSucceeded(q, fx, ctx, { paymentId: p.id, providerRef: obj.id, providerPaymentRef: piOf(obj), ...card })).result;
    } else if (event.type === 'checkout.session.async_payment_failed') {
      result = (await markFailed(q, fx, ctx, { paymentId: p.id, reason: 'bank_declined' })) ? 'failed' : 'ignored';
    } else if (event.type === 'checkout.session.expired') {
      result = OPEN.includes(p.status) && await cancelPayment(q, fx, ctx, { paymentId: p.id, why: 'session_expired' }) ? 'cancelled' : 'ignored';
    } else if (event.type === 'refund.updated' && obj.metadata?.refundId) {                   // §8.3: the job may come second
      const status = obj.status === 'succeeded' ? 'succeeded' : ['failed', 'canceled'].includes(obj.status) ? 'failed' : 'pending';
      const r = await applyRefundResult(q, fx, ctx, obj.metadata.refundId, status, { providerRef: obj.id, error: obj.failure_reason ?? obj.status });
      result = r ? `refund_${r.status}` : 'ignored';
    }
    await q.query(`UPDATE provider_events SET result = $2, payment_id = $3 WHERE provider = 'stripe' AND event_id = $1`,
      [event.id, result, p?.id ?? null]);
    return { status: 200, body: { received: true } };
  });
}

// ---- GET /pay/return (§6.5) ----

// query — { payment, session_id?, cancelled? }. → the path to redirect to | null (unknown payment).
export async function stripeReturn(db, query, opts = {}) {
  const ctx = context(opts);
  const p = await db.one('SELECT * FROM payments WHERE id = $1', [query.payment]);
  if (!p) return null;
  const b = p.booking_id && await db.one('SELECT * FROM bookings WHERE id = $1', [p.booking_id]);
  const link = b ? bookingPath(b, ctx.env) : '/';
  if (p.provider === 'click') return `${link}?pending=${p.id}`;
  if (p.provider !== 'stripe' || !OPEN.includes(p.status)) return p.status === 'succeeded' ? `${link}?paid=1` : link;
  const provider = stripeProvider(ctx.env, ctx);
  try {
    if (query.cancelled) {
      const closed = await provider.close(p);
      const refs = closed === 'paid' ? (await provider.inspect(p)).refs : null;               // the network — before the transaction
      await inTx(db, ctx, (q, fx) => (refs
        ? markSucceeded(q, fx, ctx, { paymentId: p.id, ...refs })
        : cancelPayment(q, fx, ctx, { paymentId: p.id, why: 'cancelled_by_user' })));
      return closed === 'paid' ? `${link}?paid=1` : link;
    }
    if (query.session_id && query.session_id === p.provider_ref) {
      const { state, refs } = await provider.inspect(p);
      if (state === 'paid') await inTx(db, ctx, (q, fx) => markSucceeded(q, fx, ctx, { paymentId: p.id, ...refs }));
    }
  } catch (e) {                                                                                  // the webhook or reconcile will finish it
    console.error('stripe return:', e.message);
  }
  return `${link}?paid=1`;
}
