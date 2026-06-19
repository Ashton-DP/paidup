/**
 * Paystack billing (ZAR subscriptions). REST via fetch — no SDK.
 *
 * Setup: create 3 recurring Plans in the Paystack dashboard (R299/R599/R999
 * monthly) and put their plan codes in PAYSTACK_PLAN_STARTER/GROWTH/BUSINESS.
 * If a plan code is missing we fall back to a one-off charge for the amount.
 */

const crypto = require('crypto');

// amount is in the minor unit (cents). R299 = 29900.
const PLANS = {
  starter:  { name: 'Starter',  amount: 29900, env: 'PAYSTACK_PLAN_STARTER' },
  growth:   { name: 'Growth',   amount: 59900, env: 'PAYSTACK_PLAN_GROWTH' },
  business: { name: 'Business', amount: 99900, env: 'PAYSTACK_PLAN_BUSINESS' },
};

function planCode(plan) {
  const p = PLANS[plan];
  return p ? (process.env[p.env] || '') : '';
}

async function paystack(path, method = 'GET', body) {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw new Error('PAYSTACK_SECRET_KEY not set in .env');
  const res = await fetch('https://api.paystack.co' + path, {
    method,
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status === false) {
    throw new Error(data.message || `Paystack error ${res.status}`);
  }
  return data.data;
}

// Start a subscription checkout. Returns { authorization_url, reference, ... }.
async function initSubscription({ email, plan, callbackUrl, accountId }) {
  if (!PLANS[plan]) throw new Error('Unknown plan');
  const code = planCode(plan);
  const payload = { email, callback_url: callbackUrl, metadata: { accountId, plan } };
  if (code) payload.plan = code;                  // recurring subscription
  else payload.amount = PLANS[plan].amount;       // fallback: one-off charge
  return paystack('/transaction/initialize', 'POST', payload);
}

async function verifyTransaction(reference) {
  return paystack('/transaction/verify/' + encodeURIComponent(reference));
}

// Webhook signature = HMAC SHA512 of the raw body, keyed by the secret key.
function verifyWebhook(rawBody, signature) {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key || !signature) return false;
  const hash = crypto.createHmac('sha512', key).update(rawBody).digest('hex');
  const a = Buffer.from(hash);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { PLANS, planCode, initSubscription, verifyTransaction, verifyWebhook };
