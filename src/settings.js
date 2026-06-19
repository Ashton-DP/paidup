/**
 * App settings, stored in the key/value `settings` table:
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

function getSetting(key) {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}

function getAppSettings() {
  const s = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    const v = getSetting(k);
    if (v !== null && v !== '') s[k] = (typeof DEFAULTS[k] === 'number') ? Number(v) : v;
  }
  return s;
}

// Cadence object consumed by nextChaseStage().
function getCadence() {
  const s = getAppSettings();
  return { stage1: s.stage1_days, stage2: s.stage2_days, stage3: s.stage3_days, cooldown: s.cooldown_days };
}

module.exports = { getSetting, setSetting, getAppSettings, getCadence, DEFAULTS };
