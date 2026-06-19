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

function findAccountByEmail(email) {
  return db.prepare(`SELECT * FROM accounts WHERE email = ?`)
    .get(String(email || '').trim().toLowerCase());
}

function getAccount(id) {
  return db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id);
}

function createAccount({ email, password, businessName, trialEndsAt }) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Please enter a valid email address');
  if (!password || String(password).length < 8) throw new Error('Password must be at least 8 characters');
  if (findAccountByEmail(email)) throw new Error('An account with that email already exists');

  const id = genId();
  db.prepare(`INSERT INTO accounts (id, email, password_hash, business_name, plan, trial_ends_at)
              VALUES (?, ?, ?, ?, 'trial', ?)`)
    .run(id, email, hashPassword(password), businessName || '', trialEndsAt || null);
  return getAccount(id);
}

function verifyLogin(email, password) {
  const acc = findAccountByEmail(email);
  if (!acc) return null;
  return verifyPassword(password, acc.password_hash) ? acc : null;
}

module.exports = {
  hashPassword, verifyPassword, findAccountByEmail, getAccount, createAccount, verifyLogin,
};
