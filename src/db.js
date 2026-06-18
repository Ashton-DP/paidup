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
`);

module.exports = db;
