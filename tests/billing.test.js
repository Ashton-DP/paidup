const { test } = require('node:test');
const assert = require('node:assert');

process.env.STRIPE_SECRET_KEY = 'sk_test_unit';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
const stripeClient = require('../src/stripe');
const { isActive, trialDaysLeft } = require('../src/accounts');

const daysFromNow = n => new Date(Date.now() + n * 86400000).toISOString();
const daysAgo     = n => new Date(Date.now() - n * 86400000).toISOString();

test('verifyWebhook returns null for missing/invalid signature', () => {
  const body = Buffer.from(JSON.stringify({ type: 'checkout.session.completed' }));
  assert.strictEqual(stripeClient.verifyWebhook(body, ''), null);
  assert.strictEqual(stripeClient.verifyWebhook(body, null), null);
  assert.strictEqual(stripeClient.verifyWebhook(body, 'bad-sig'), null);
});

test('PLANS map has the three ZAR tiers (in cents)', () => {
  assert.strictEqual(stripeClient.PLANS.starter.amount, 29900);
  assert.strictEqual(stripeClient.PLANS.growth.amount, 59900);
  assert.strictEqual(stripeClient.PLANS.business.amount, 99900);
});

test('isActive: active subscription', () => {
  assert.strictEqual(isActive({ subscription_status: 'active' }), true);
});
test('isActive: trialing within window active, expired not', () => {
  assert.strictEqual(isActive({ subscription_status: 'trialing', trial_ends_at: daysFromNow(3) }), true);
  assert.strictEqual(isActive({ subscription_status: 'trialing', trial_ends_at: daysAgo(1) }), false);
});
test('isActive: cancelled / past_due / null are inactive', () => {
  assert.strictEqual(isActive({ subscription_status: 'cancelled', trial_ends_at: daysFromNow(3) }), false);
  assert.strictEqual(isActive({ subscription_status: 'past_due' }), false);
  assert.strictEqual(isActive(null), false);
});
test('trialDaysLeft counts down, zero when not trialing/expired', () => {
  assert.ok(trialDaysLeft({ subscription_status: 'trialing', trial_ends_at: daysFromNow(5) }) >= 4);
  assert.strictEqual(trialDaysLeft({ subscription_status: 'active', trial_ends_at: daysFromNow(5) }), 0);
  assert.strictEqual(trialDaysLeft({ subscription_status: 'trialing', trial_ends_at: daysAgo(1) }), 0);
});
