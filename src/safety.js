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

function addSuppression(tenantId, channel, identifier, reason = 'stop') {
  if (!identifier) return false;
  db.prepare(`INSERT OR IGNORE INTO suppressions (tenant_id, channel, identifier, reason)
              VALUES (?, ?, ?, ?)`).run(tenantId, channel, identifier, reason);
  return true;
}

function isSuppressed(tenantId, channel, identifier) {
  if (!identifier) return false;
  const row = db.prepare(`SELECT 1 FROM suppressions
                          WHERE tenant_id = ? AND channel = ? AND identifier = ?`)
    .get(tenantId, channel, identifier);
  return !!row;
}

// ── Global kill switch ───────────────────────────────────────────────────────

function isChasingPaused() {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'chasing_paused'`).get();
  return row?.value === '1';
}

function setChasingPaused(paused) {
  db.prepare(`INSERT INTO settings (key, value) VALUES ('chasing_paused', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(paused ? '1' : '0');
  return isChasingPaused();
}

module.exports = {
  phoneKey, emailKey,
  addSuppression, isSuppressed,
  isChasingPaused, setChasingPaused,
};
