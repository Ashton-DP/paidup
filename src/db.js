const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'chaser.db');
require('fs').mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  -- A customer account = one paying business. Owns its tenants/invoices/settings.
  CREATE TABLE IF NOT EXISTS accounts (
    id            TEXT PRIMARY KEY,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    business_name TEXT,
    plan          TEXT DEFAULT 'trial',
    trial_ends_at TEXT,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tenants (
    id          TEXT PRIMARY KEY,
    account_id  TEXT,
    name        TEXT NOT NULL,
    xero_tenant_id TEXT UNIQUE NOT NULL,
    tokens      TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id              TEXT PRIMARY KEY,
    tenant_id       TEXT NOT NULL REFERENCES tenants(id),
    xero_invoice_id TEXT NOT NULL,
    invoice_number  TEXT,
    contact_name    TEXT,
    contact_email   TEXT,
    contact_phone   TEXT,
    amount_due      REAL,
    currency        TEXT DEFAULT 'ZAR',
    due_date        TEXT,
    days_overdue    INTEGER DEFAULT 0,
    status          TEXT DEFAULT 'OVERDUE',
    chase_stage     INTEGER DEFAULT 0,
    last_chased_at  TEXT,
    paid_at         TEXT,
    snoozed_until   TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now')),
    UNIQUE(tenant_id, xero_invoice_id)
  );

  CREATE TABLE IF NOT EXISTS chase_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id   TEXT NOT NULL REFERENCES invoices(id),
    tenant_id    TEXT NOT NULL,
    stage        INTEGER NOT NULL,
    channel      TEXT NOT NULL,
    recipient    TEXT NOT NULL,
    message_body TEXT,
    status       TEXT DEFAULT 'sent',
    sent_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS replies (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id    TEXT NOT NULL,
    from_number  TEXT,
    from_email   TEXT,
    body         TEXT NOT NULL,
    channel      TEXT NOT NULL,
    processed    INTEGER DEFAULT 0,
    received_at  TEXT DEFAULT (datetime('now'))
  );

  -- Opt-out list. Once a contact says STOP on a channel we never message that
  -- channel again (POPIA / WhatsApp policy). identifier = email or phone key.
  CREATE TABLE IF NOT EXISTS suppressions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id   TEXT NOT NULL,
    channel     TEXT NOT NULL,
    identifier  TEXT NOT NULL,
    reason      TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    UNIQUE(tenant_id, channel, identifier)
  );

  -- Per-account key/value settings (business name, cadence, kill switch).
  -- Created/migrated to the account-scoped schema in the migrations below.

  -- Marketing waitlist sign-ups from the landing page.
  CREATE TABLE IF NOT EXISTS waitlist (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    email       TEXT UNIQUE NOT NULL,
    created_at  TEXT DEFAULT (datetime('now'))
  );
`);

// ── Lightweight migrations (add columns to existing tables) ──────────────────
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
// A 'dispute' reply pauses chasing on the invoice until a human resolves it.
ensureColumn('invoices', 'disputed', 'INTEGER DEFAULT 0');
// Multi-tenancy: tenants belong to an account.
ensureColumn('tenants', 'account_id', 'TEXT');

// Settings are per-account. If an older global settings table exists (no
// account_id column), drop it — the values (cadence/kill switch) re-default
// per account. Then ensure the account-scoped schema.
const settingsCols = db.prepare(`PRAGMA table_info(settings)`).all();
if (settingsCols.length && !settingsCols.some(c => c.name === 'account_id')) {
  db.exec(`DROP TABLE settings`);
}
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    account_id TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT,
    PRIMARY KEY (account_id, key)
  );
`);

module.exports = db;
