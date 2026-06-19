const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'chaser.db');
require('fs').mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS tenants (
    id          TEXT PRIMARY KEY,
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

  -- Simple key/value store for app-wide settings (e.g. the chasing kill switch).
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

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

module.exports = db;
