// npm run stripe:check — the first-day check of 05 §6.2 (D-05): a Checkout session for 1 000 000 000 (10 000 000 sum)
// in STRIPE_CURRENCY; Stripe took it → the page opens → the session is expired at once. Needs STRIPE_SECRET_KEY (sk_test_).
// Did not pass with uzs → STRIPE_CURRENCY=usd and STRIPE_USD_RATE, no code changes.
import Stripe from 'stripe';
import { stripeConfig, stripeMoney } from '../server/payments/stripe.js';

const cfg = stripeConfig();
if (!cfg.key.startsWith('sk_test_')) {
  console.error(cfg.live ? 'A live key: only sk_test_ is allowed.' : 'STRIPE_SECRET_KEY (sk_test_…) is not set.');
  process.exit(1);
}
if (cfg.currency === 'usd' && !(cfg.rate > 0)) {
  console.error('STRIPE_CURRENCY=usd needs STRIPE_USD_RATE.');
  process.exit(1);
}
const stripe = new Stripe(cfg.key);
const { currency, providerAmount } = stripeMoney(10_000_000, cfg);
const base = process.env.PUBLIC_URL || 'https://example.com';
try {
  const s = await stripe.checkout.sessions.create({
    mode: 'payment', allowed_payment_method_types: ['card'],
    line_items: [{ quantity: 1, price_data: { currency: currency.toLowerCase(), unit_amount: providerAmount,
      product_data: { name: 'stripe:check — Domus Estate' } } }],
    success_url: `${base}/?stripe_check=ok`, cancel_url: `${base}/?stripe_check=cancel`
  });
  const page = await fetch(s.url, { redirect: 'follow' });
  await stripe.checkout.sessions.expire(s.id);
  console.log(`ok: ${currency} ${providerAmount} accepted, the page answers ${page.status}, the session is expired.`);
  if (!page.ok) process.exitCode = 1;
} catch (e) {
  console.error(`not accepted (${currency} ${providerAmount}): ${e.message}`);
  if (currency === 'UZS') console.error('Fallback (D-05): STRIPE_CURRENCY=usd, STRIPE_USD_RATE=12700.');
  process.exitCode = 1;
}
