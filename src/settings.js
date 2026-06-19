/**
 * Per-account settings, stored in the account-scoped `settings` table:
 *   - business_name : overrides the sender name on messages + email "from"
 *   - chase cadence : the day thresholds for stages 1/2/3 and the re-chase gap
 */

const db = require('./db');

const DEFAULTS = {
  business_name: '',
  stage1_days: 1,
  stage2_days: 7,
  stage3_days: 21,
  cooldown_days: 6,
};

function getSetting(accountId, key) {
  const row = db.prepare(`SELECT value FROM settings WHERE account_id = ? AND key = ?`).get(accountId, key);
  return row ? row.value : null;
}

function setSetting(accountId, key, value) {
  db.prepare(`INSERT INTO settings (account_id, key, value) VALUES (?, ?, ?)
              ON CONFLICT(account_id, key) DO UPDATE SET value = excluded.value`)
    .run(accountId, key, String(value));
}

function getAppSettings(accountId) {
  const s = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    const v = getSetting(accountId, k);
    if (v !== null && v !== '') s[k] = (typeof DEFAULTS[k] === 'number') ? Number(v) : v;
  }
  return s;
}

// Cadence object consumed by nextChaseStage().
function getCadence(accountId) {
  const s = getAppSettings(accountId);
  return { stage1: s.stage1_days, stage2: s.stage2_days, stage3: s.stage3_days, cooldown: s.cooldown_days };
}

module.exports = { getSetting, setSetting, getAppSettings, getCadence, DEFAULTS };
