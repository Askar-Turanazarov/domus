// The provider registry (05 §2.3, FR-PAY-01): the rest of the system knows only payment.status and the reason key.
// A provider — { id, label, mode(), enabled(), money(amount), begin(payment, ctx), close(payment), refund(payment, refund),
// inspect(payment) }. Stripe is loaded lazily (05 §1): its SDK is heavy and the emulators do not need it.
import crypto from 'node:crypto';

export const ORDER = ['card', 'click', 'stripe'];        // the order of the buttons on the payment page
const MAKERS = {
  card: () => import('./card.js').then(m => m.cardProvider),
  click: () => import('./click.js').then(m => m.clickProvider),
  stripe: () => import('./stripe.js').then(m => m.stripeProvider)
};

// 'rf_' / 'card_' + 12 hex: ids the emulators give to what a real provider would number.
export const fakeRef = prefix => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;

// opts — the caller's context { env, now, providers?, stripe? }: providers — { id: provider } given by tests instead of
// the real ones; stripe — a fake Stripe client. → the provider | null.
export async function getProvider(id, opts = {}) {
  const { env = process.env, providers = null } = opts;
  if (providers) return providers[id] ?? null;
  if (!MAKERS[id]) return null;
  return (await MAKERS[id]())(env, opts);
}

// Enabled providers in page order.
export async function enabledProviders(opts = {}) {
  const all = await Promise.all(ORDER.map(id => getProvider(id, opts)));
  return all.filter(p => p?.enabled());
}
