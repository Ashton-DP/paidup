/**
 * Safety & compliance helpers for the chase engine:
 *   - opt-out suppression list (honour STOP replies)
 *   - global "pause all chasing" kill switch
 *
 * The key-derivation functions are pure so they can be unit-tested.
 */

const db = require('./db');

// Normalise a phone number to a stable key for matching across formats.
// SA numbers collapse to their last 9 digits (the part after +27 / 0).
function phoneKey(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length < 9) return null;
  return digits.slice(-9);
}

// Normalise an email to a stable key.
function emailKey(raw) {
  if (!raw) return null;
  const e = String(raw).trim().toLowerCase();
  return e.includes('@') ? e : null;
}

// ── Suppression list (opt-outs) ──────────────────────────────────────────────

async function addSuppression(tenantId, channel, identifier, reason = 'stop') {
  if (!identifier) return false;
  await db.run(
    `INSERT INTO suppressions (tenant_id, channel, identifier, reason)
     VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    tenantId, channel, identifier, reason
  );
  return true;
}

async function isSuppressed(tenantId, channel, identifier) {
  if (!identifier) return false;
  const row = await db.get(
    `SELECT 1 FROM suppressions WHERE tenant_id = ? AND channel = ? AND identifier = ?`,
    tenantId, channel, identifier
  );
  return !!row;
}

// ── Global kill switch ───────────────────────────────────────────────────────

async function isChasingPaused(accountId) {
  const row = await db.get(
    `SELECT value FROM settings WHERE account_id = ? AND key = 'chasing_paused'`,
    accountId
  );
  return row?.value === '1';
}

async function setChasingPaused(accountId, paused) {
  await db.run(
    `INSERT INTO settings (account_id, key, value) VALUES (?, 'chasing_paused', ?)
     ON CONFLICT(account_id, key) DO UPDATE SET value = excluded.value`,
    accountId, paused ? '1' : '0'
  );
  return isChasingPaused(accountId);
}

module.exports = {
  phoneKey, emailKey,
  addSuppression, isSuppressed,
  isChasingPaused, setChasingPaused,
};
