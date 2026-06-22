/**
 * Database client — PostgreSQL via the `pg` package.
 *
 * Exports a thin wrapper with the same get/all/run/exec API that the rest of
 * the codebase used with better-sqlite3, but all methods are now async.
 *
 * Connection: DATABASE_URL env var (Railway / any Postgres).
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Always enable SSL when DATABASE_URL is set — Railway and most managed Postgres
  // require it. rejectUnauthorized:false accepts self-signed certs (Railway uses these).
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// Convert SQLite-style ? placeholders to Postgres $1, $2, ...
function pgSql(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// Convert SQLite datetime('now') / datetime('now', ...) → NOW()
function normSql(sql) {
  return pgSql(sql)
    .replace(/datetime\('now'\s*(?:,\s*[^)]+)?\)/gi, 'NOW()')
    .replace(/INSERT OR IGNORE/gi, 'INSERT')
    .replace(/ON CONFLICT\s*DO NOTHING/gi, '')  // handled per-query below
    ;
}

const db = {
  async get(sql, ...params) {
    const res = await pool.query(normSql(sql), params.flat());
    return res.rows[0] || null;
  },
  async all(sql, ...params) {
    const res = await pool.query(normSql(sql), params.flat());
    return res.rows;
  },
  async run(sql, ...params) {
    const res = await pool.query(normSql(sql), params.flat());
    return { changes: res.rowCount };
  },
  async exec(sql) {
    await pool.query(sql);
  },
  pool,
};

// ── Schema (idempotent) ───────────────────────────────────────────────────────
async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id                         TEXT PRIMARY KEY,
      email                      TEXT UNIQUE NOT NULL,
      password_hash              TEXT NOT NULL,
      business_name              TEXT,
      plan                       TEXT DEFAULT 'trial',
      trial_ends_at              TEXT,
      created_at                 TIMESTAMPTZ DEFAULT NOW(),
      subscription_status        TEXT DEFAULT 'trialing',
      paystack_customer_code     TEXT,
      paystack_subscription_code TEXT,
      current_period_end         TEXT
    );

    CREATE TABLE IF NOT EXISTS tenants (
      id             TEXT PRIMARY KEY,
      account_id     TEXT,
      name           TEXT NOT NULL,
      xero_tenant_id TEXT UNIQUE NOT NULL,
      tokens         TEXT,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id              TEXT PRIMARY KEY,
      tenant_id       TEXT NOT NULL REFERENCES tenants(id),
      xero_invoice_id TEXT NOT NULL,
      invoice_number  TEXT,
      contact_name    TEXT,
      contact_email   TEXT,
      contact_phone   TEXT,
      amount_due      NUMERIC,
      currency        TEXT DEFAULT 'ZAR',
      due_date        TEXT,
      days_overdue    INTEGER DEFAULT 0,
      status          TEXT DEFAULT 'OVERDUE',
      chase_stage     INTEGER DEFAULT 0,
      last_chased_at  TEXT,
      paid_at         TEXT,
      snoozed_until   TEXT,
      disputed        INTEGER DEFAULT 0,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(tenant_id, xero_invoice_id)
    );

    CREATE TABLE IF NOT EXISTS chase_log (
      id           SERIAL PRIMARY KEY,
      invoice_id   TEXT NOT NULL REFERENCES invoices(id),
      tenant_id    TEXT NOT NULL,
      stage        INTEGER NOT NULL,
      channel      TEXT NOT NULL,
      recipient    TEXT NOT NULL,
      message_body TEXT,
      status       TEXT DEFAULT 'sent',
      sent_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS replies (
      id          SERIAL PRIMARY KEY,
      tenant_id   TEXT NOT NULL,
      from_number TEXT,
      from_email  TEXT,
      body        TEXT NOT NULL,
      channel     TEXT NOT NULL,
      processed   INTEGER DEFAULT 0,
      received_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS suppressions (
      id         SERIAL PRIMARY KEY,
      tenant_id  TEXT NOT NULL,
      channel    TEXT NOT NULL,
      identifier TEXT NOT NULL,
      reason     TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(tenant_id, channel, identifier)
    );

    CREATE TABLE IF NOT EXISTS settings (
      account_id TEXT NOT NULL,
      key        TEXT NOT NULL,
      value      TEXT,
      PRIMARY KEY (account_id, key)
    );

    CREATE TABLE IF NOT EXISTS waitlist (
      id         SERIAL PRIMARY KEY,
      email      TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Migrations — idempotent (ADD COLUMN IF NOT EXISTS is safe to run every boot)
  await pool.query(`
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'xero';
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS sage_company_id TEXT;
  `);
  // Make xero_tenant_id nullable so Sage tenants can live in the same table
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE tenants ALTER COLUMN xero_tenant_id DROP NOT NULL;
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `);
  console.log('[db] schema ready');
}

initSchema().catch(err => {
  // In test environments without a DATABASE_URL the pool connection will fail.
  // Log the error but don't crash — pure-function tests don't need a live DB.
  if (process.env.NODE_ENV !== 'test') {
    console.error('[db] schema init failed:', err.message, '| code:', err.code, '| DATABASE_URL set:', !!process.env.DATABASE_URL);
    process.exit(1);
  } else {
    console.warn('[db] schema init skipped (no DATABASE_URL in test env)');
  }
});

module.exports = db;
