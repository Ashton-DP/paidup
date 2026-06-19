const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

process.env.PAYSTACK_SECRET_KEY = 'sk_test_unit';
const paystack = require('../src/paystack');
const { isActive, trialDaysLeft } = require('../src/accounts');

const daysFromNow = n => new Date(Date.now() + n * 86400000).toISOString();
const daysAgo     = n => new Date(Date.now() - n * 86400000).toISOString();

test('verifyWebhook accepts a correctly-signed body, rejects tampered/empty', () => {
  const body = Buffer.from(JSON.stringify({ event: 'charge.success' }));
  const sig = crypto.createHmac('sha512', 'sk_test_unit').update(body).digest('hex');
  assert.strictEqual(paystack.verifyWebhook(body, sig), true);
  assert.strictEqual(paystack.verifyWebhook(body, 'deadbeef'), false);
  assert.strictEqual(paystack.verifyWebhook(body, ''), false);
});

test('PLANS map has the three ZAR tiers (in cents)', () => {
  assert.strictEqual(paystack.PLANS.starter.amount, 29900);
  assert.strictEqual(paystack.PLANS.growth.amount, 59900);
  assert.strictEqual(paystack.PLANS.business.amount, 99900);
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
