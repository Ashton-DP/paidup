/**
 * Customer accounts + authentication. One account = one paying business.
 * Passwords hashed with scrypt (built-in crypto, no dependency).
 */

const crypto = require('crypto');
const db = require('./db');

const genId = () => `${Date.now()}_${Math.random().toString(36).slice(2)}`;

// scrypt hash, stored as "salt:hash" (both hex).
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function findAccountByEmail(email) {
  return db.get(`SELECT * FROM accounts WHERE email = ?`, String(email || '').trim().toLowerCase());
}

async function getAccount(id) {
  return db.get(`SELECT * FROM accounts WHERE id = ?`, id);
}

async function createAccount({ email, password, businessName, trialEndsAt }) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Please enter a valid email address');
  if (!password || String(password).length < 8) throw new Error('Password must be at least 8 characters');
  if (await findAccountByEmail(email)) throw new Error('An account with that email already exists');

  const id = genId();
  await db.run(
    `INSERT INTO accounts (id, email, password_hash, business_name, plan, trial_ends_at)
     VALUES (?, ?, ?, ?, 'trial', ?)`,
    id, email, hashPassword(password), businessName || '', trialEndsAt || null
  );
  return getAccount(id);
}

async function verifyLogin(email, password) {
  const acc = await findAccountByEmail(email);
  if (!acc) return null;
  return verifyPassword(password, acc.password_hash) ? acc : null;
}

// An account may use PaidUp if it has an active subscription OR is still within
// its free trial.
function isActive(account) {
  if (!account) return false;
  if (account.subscription_status === 'active') return true;
  if (account.subscription_status === 'trialing' && account.trial_ends_at
      && new Date(account.trial_ends_at) > new Date()) return true;
  return false;
}

// Days left in the trial (0 if expired / not trialing).
function trialDaysLeft(account) {
  if (!account || account.subscription_status !== 'trialing' || !account.trial_ends_at) return 0;
  return Math.max(0, Math.ceil((new Date(account.trial_ends_at) - new Date()) / 86400000));
}

async function findByStripeCustomer(stripeCustomerId) {
  if (!stripeCustomerId) return null;
  return db.get(`SELECT * FROM accounts WHERE paystack_customer_code = ?`, stripeCustomerId);
}

async function setSubscription(accountId, { plan, status, customerCode, subscriptionCode, periodEnd }) {
  const cur = await getAccount(accountId);
  if (!cur) return;
  await db.run(
    `UPDATE accounts SET
      plan = COALESCE(?, plan),
      subscription_status = COALESCE(?, subscription_status),
      paystack_customer_code = COALESCE(?, paystack_customer_code),
      paystack_subscription_code = COALESCE(?, paystack_subscription_code),
      current_period_end = COALESCE(?, current_period_end)
    WHERE id = ?`,
    plan || null, status || null, customerCode || null, subscriptionCode || null, periodEnd || null, accountId
  );
  return getAccount(accountId);
}

module.exports = {
  hashPassword, verifyPassword, findAccountByEmail, getAccount, createAccount, verifyLogin,
  isActive, trialDaysLeft, setSubscription, findByStripeCustomer,
};
