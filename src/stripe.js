/**
 * Stripe billing (ZAR subscriptions).
 *
 * Setup:
 *   1. In the Stripe dashboard create 3 Products with monthly recurring Prices
 *      (R299 / R599 / R999 in ZAR) and copy the price_xxx IDs into env vars.
 *   2. Add a webhook endpoint pointing at https://paid-up.co.za/stripe/webhook
 *      listening for: checkout.session.completed, customer.subscription.updated,
 *      customer.subscription.deleted, invoice.payment_failed
 *   3. Copy the webhook signing secret into STRIPE_WEBHOOK_SECRET.
 */

const Stripe = require('stripe');

function client() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY not set');
  return Stripe(key);
}

// amount is in the minor unit (cents). R299 = 29900.
const PLANS = {
  starter:  { name: 'Starter',  amount: 29900, env: 'STRIPE_PRICE_STARTER' },
  growth:   { name: 'Growth',   amount: 59900, env: 'STRIPE_PRICE_GROWTH' },
  business: { name: 'Business', amount: 99900, env: 'STRIPE_PRICE_BUSINESS' },
};

function priceId(plan) {
  const p = PLANS[plan];
  return p ? (process.env[p.env] || '') : '';
}

// Create a Stripe Checkout session. Returns the session (use session.url to redirect).
async function createCheckoutSession({ email, plan, accountId, successUrl, cancelUrl }) {
  if (!PLANS[plan]) throw new Error('Unknown plan');
  const price = priceId(plan);
  if (!price) throw new Error(`STRIPE_PRICE_${plan.toUpperCase()} not configured`);
  const stripe = client();
  return stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: email,
    line_items: [{ price, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { accountId, plan },
    subscription_data: { metadata: { accountId, plan } },
  });
}

// Verify a Stripe webhook signature. Returns the parsed Event or null on failure.
function verifyWebhook(rawBody, signature) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !signature) return null;
  try {
    return Stripe(process.env.STRIPE_SECRET_KEY)
      .webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    return null;
  }
}

module.exports = { PLANS, priceId, createCheckoutSession, verifyWebhook };
