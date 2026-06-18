const path = require('path');
// Load .env relative to this file, not the process cwd — so the app works no
// matter what directory it's launched from (preview tools, Render, cron, etc.).
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const session = require('express-session');
const cron = require('node-cron');

const db = require('./src/db');
const { getAuthUrl, handleCallback, syncOverdueInvoices,
        validateWebhook, markPaid } = require('./src/xero');
const { runChaseAll, runChaseForTenant, handleReply } = require('./src/chaser');
const { parseReplyIntent } = require('./src/whatsapp');
const { isChasingPaused, setChasingPaused } = require('./src/safety');
const { csvToInvoices } = require('./src/csv');
const { daysOverdue } = require('./src/xeroUtils');

const app = express();

// Pick the org to show/operate on: the one with the most overdue invoices (so
// the dashboard surfaces the org that actually has work), tie-broken by the
// most recently connected. MVP assumes a single active tenant.
function activeTenant() {
  return db.prepare(`
    SELECT t.* FROM tenants t
    LEFT JOIN invoices i ON i.tenant_id = t.id AND i.status = 'OVERDUE'
    GROUP BY t.id
    ORDER BY COUNT(i.id) DESC, t.created_at DESC
    LIMIT 1
  `).get();
}

const genId = () => `${Date.now()}_${Math.random().toString(36).slice(2)}`;

// Manual / CSV invoices attach to the active org, or to a local "My Business"
// tenant created on demand — so PaidUp is usable with no Xero connection.
function targetTenantForManual() {
  const existing = activeTenant();
  if (existing) return existing;
  const id = genId();
  db.prepare(`INSERT INTO tenants (id, name, xero_tenant_id, tokens)
              VALUES (?, 'My Business', ?, NULL)`).run(id, 'local-' + id);
  return db.prepare(`SELECT * FROM tenants WHERE id = ?`).get(id);
}

function insertManualInvoice(tenantId, f) {
  const over = f.due_date ? daysOverdue(f.due_date) : 0;
  db.prepare(`INSERT INTO invoices
    (id, tenant_id, xero_invoice_id, invoice_number, contact_name, contact_email,
     contact_phone, amount_due, currency, due_date, days_overdue, status, chase_stage)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OVERDUE', 0)`).run(
    genId(), tenantId, 'manual-' + genId(), f.invoice_number || null,
    f.contact_name || 'Unknown', f.contact_email || null, f.contact_phone || null,
    f.amount_due, (f.currency || 'ZAR').toUpperCase(), f.due_date, over);
}

function loginPage(error) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PaidUp — Sign in</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    background:#0f0f13;color:#e8e8ec;min-height:100vh;display:flex;
    align-items:center;justify-content:center}
  .card{background:#18181f;border:1px solid #2a2a35;border-radius:12px;
    padding:36px 32px;width:340px}
  .logo{font-size:22px;font-weight:600;color:#fff;margin-bottom:6px}
  .logo span{color:#6c8fff}
  .sub{color:#888;font-size:13px;margin-bottom:24px}
  label{display:block;font-size:12px;color:#888;margin-bottom:6px;
    text-transform:uppercase;letter-spacing:.05em}
  input{width:100%;background:#0f0f13;border:1px solid #2a2a35;border-radius:8px;
    padding:11px 14px;color:#e8e8ec;font-size:14px;margin-bottom:16px}
  input:focus{outline:none;border-color:#6c8fff}
  button{width:100%;background:#6c8fff;color:#fff;border:none;border-radius:8px;
    padding:12px;font-size:14px;font-weight:600;cursor:pointer}
  button:hover{opacity:.9}
  .err{background:#4a2020;color:#ffb3b3;border:1px solid #6b2737;border-radius:8px;
    padding:9px 12px;font-size:12px;margin-bottom:16px}
</style></head><body>
  <form class="card" method="POST" action="/login">
    <div class="logo">Paid<span>Up</span></div>
    <div class="sub">Sign in to your dashboard</div>
    ${error ? `<div class="err">Incorrect password. Try again.</div>` : ''}
    <label for="password">Password</label>
    <input type="password" id="password" name="password" autofocus required>
    <button type="submit">Sign in</button>
  </form>
</body></html>`;
}

const isProd = process.env.NODE_ENV === 'production';
// Behind a hosting proxy (Render/Heroku/etc.) Express must trust it so secure
// cookies and req.protocol work correctly.
if (isProd) app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProd,            // HTTPS-only cookie in production
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
  },
}));

// ── Auth gate ────────────────────────────────────────────────────────────────
// A password gate over the dashboard + API so a public deployment isn't wide
// open. External callbacks (OAuth, webhooks) stay public — they validate
// themselves. Enforced whenever DASHBOARD_PASSWORD is set; in production we
// fail CLOSED if it's missing so data is never served unprotected.
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const AUTH_REQUIRED = !!DASHBOARD_PASSWORD;
const PUBLIC_PATHS = new Set([
  '/login', '/logout',
  '/xero/connect', '/xero/callback', '/xero/webhook', '/twilio/reply',
]);
function requireAuth(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (!AUTH_REQUIRED) {
    if (isProd) return res.status(503)
      .send('Dashboard locked: set DASHBOARD_PASSWORD to enable access.');
    return next(); // dev convenience when no password is configured
  }
  if (req.session && req.session.authed) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'auth required' });
  return res.redirect('/login');
}
app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

// ── Login ──────────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (!AUTH_REQUIRED || req.session?.authed) return res.redirect('/');
  res.type('html').send(loginPage(!!req.query.error));
});
app.post('/login', (req, res) => {
  if (AUTH_REQUIRED && req.body.password === DASHBOARD_PASSWORD) {
    req.session.authed = true;
    return res.redirect('/');
  }
  res.redirect('/login?error=1');
});
app.get('/logout', (req, res) => {
  if (req.session) req.session.authed = false;
  res.redirect('/login');
});

// ── Xero OAuth ─────────────────────────────────────────────────────────────

app.get('/xero/connect', async (req, res) => {
  const url = await getAuthUrl();
  res.redirect(url);
});

app.get('/xero/callback', async (req, res) => {
  try {
    const tenant = await handleCallback(`${process.env.BASE_URL}/xero/callback?${new URLSearchParams(req.query)}`);
    req.session.tenantId = tenant.tenantId;
    res.redirect('/?connected=1');
  } catch (err) {
    console.error('[xero callback] FULL ERROR ↓');
    console.error('  message :', err && err.message);
    console.error('  name    :', err && err.name);
    console.error('  body    :', err && (err.body || err.response?.body || err.data));
    console.error('  stack   :', err && err.stack);
    res.redirect('/?error=xero_auth_failed');
  }
});

// ── Xero webhook (invoice paid / updated) ──────────────────────────────────

app.post('/xero/webhook', express.raw({ type: '*/*' }), (req, res) => {
  const sig = req.headers['x-xero-signature'];
  if (!validateWebhook(req.body, sig)) return res.sendStatus(401);

  res.sendStatus(200); // must respond quickly

  try {
    const events = JSON.parse(req.body.toString()).events || [];
    for (const ev of events) {
      if (ev.eventType === 'UPDATE' && ev.eventCategory === 'INVOICE') {
        const tenant = db.prepare(`SELECT * FROM tenants WHERE xero_tenant_id = ?`)
          .get(ev.tenantId);
        if (tenant) markPaid(tenant.id, ev.resourceId);
      }
    }
  } catch (err) {
    console.error('[xero webhook]', err.message);
  }
});

// ── Twilio WhatsApp inbound reply ──────────────────────────────────────────

app.post('/twilio/reply', (req, res) => {
  const { From, Body } = req.body;
  const intent = parseReplyIntent(Body);
  const tenants = db.prepare(`SELECT * FROM tenants`).all();
  const tenant = tenants[0]; // single-tenant MVP

  if (tenant) handleReply({ tenantId: tenant.id, fromNumber: From, body: Body, intent });

  // Twilio expects TwiML response (empty is fine — no auto-reply in MVP)
  res.type('text/xml').send('<Response></Response>');
});

// ── Dashboard API ──────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  const tenant = activeTenant();
  if (!tenant) return res.json({ connected: false });

  const stats = db.prepare(`
    SELECT
      COUNT(*)                                             AS total_overdue,
      COALESCE(SUM(amount_due), 0)                         AS total_value,
      COUNT(CASE WHEN status = 'PAID' THEN 1 END)          AS paid_count,
      COALESCE(SUM(CASE WHEN status = 'PAID' THEN amount_due END), 0) AS recovered,
      COUNT(CASE WHEN chase_stage >= 1 THEN 1 END)         AS chased_count
    FROM invoices WHERE tenant_id = ?
  `).get(tenant.id);

  const invoices = db.prepare(`
    SELECT * FROM invoices WHERE tenant_id = ? AND status = 'OVERDUE'
    ORDER BY days_overdue DESC LIMIT 50
  `).all(tenant.id);

  const recent = db.prepare(`
    SELECT cl.*, i.invoice_number, i.contact_name FROM chase_log cl
    JOIN invoices i ON i.id = cl.invoice_id
    WHERE cl.tenant_id = ? ORDER BY cl.sent_at DESC LIMIT 20
  `).all(tenant.id);

  // Most common currency among this org's overdue invoices, for stat totals.
  const curRow = db.prepare(`
    SELECT currency, COUNT(*) c FROM invoices
    WHERE tenant_id = ? AND status = 'OVERDUE'
    GROUP BY currency ORDER BY c DESC LIMIT 1
  `).get(tenant.id);

  res.json({ connected: true, tenant: tenant.name,
             currency: curRow?.currency || 'ZAR', paused: isChasingPaused(),
             stats, invoices, recent });
});

app.get('/api/invoices', (req, res) => {
  const tenant = activeTenant();
  if (!tenant) return res.json([]);
  const rows = db.prepare(`SELECT * FROM invoices WHERE tenant_id = ?
                            ORDER BY days_overdue DESC`).all(tenant.id);
  res.json(rows);
});

app.post('/api/sync', async (req, res) => {
  const tenant = activeTenant();
  if (!tenant) return res.status(400).json({ error: 'Not connected to Xero' });
  try {
    const count = await syncOverdueInvoices(tenant);
    res.json({ synced: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pause', (req, res) => {
  res.json({ paused: setChasingPaused(!!req.body.paused) });
});

// Add a single invoice manually (no Xero needed).
app.post('/api/invoices/manual', (req, res) => {
  const { contact_name, amount_due, due_date } = req.body;
  const amount = parseFloat(amount_due);
  if (!contact_name || !(amount > 0) || !due_date) {
    return res.status(400).json({ error: 'Name, a positive amount, and a due date are required' });
  }
  const tenant = targetTenantForManual();
  insertManualInvoice(tenant.id, {
    contact_name,
    contact_email: req.body.contact_email,
    contact_phone: req.body.contact_phone,
    invoice_number: req.body.invoice_number,
    amount_due: amount,
    currency: req.body.currency,
    due_date,
  });
  res.json({ ok: true });
});

// Import overdue invoices from CSV text (Sage/QuickBooks/spreadsheet export).
app.post('/api/invoices/import', (req, res) => {
  const { invoices, skipped } = csvToInvoices(req.body.csv || '');
  if (!invoices.length) {
    return res.status(400).json({ error: 'No valid rows found (need name, amount, due date)', skipped });
  }
  const tenant = targetTenantForManual();
  db.transaction(rows => rows.forEach(r => insertManualInvoice(tenant.id, r)))(invoices);
  res.json({ imported: invoices.length, skipped });
});

app.post('/api/chase-now', async (req, res) => {
  const tenant = activeTenant();
  if (!tenant) return res.status(400).json({ error: 'Not connected to Xero' });
  try {
    const count = await runChaseForTenant(tenant);
    res.json({ chased: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/invoice/:id/snooze', (req, res) => {
  const days = parseInt(req.body.days) || 5;
  db.prepare(`UPDATE invoices SET snoozed_until = datetime('now', ?),
              updated_at = datetime('now') WHERE id = ?`)
    .run(`+${days} days`, req.params.id);
  res.json({ ok: true });
});

app.post('/api/invoice/:id/paid', (req, res) => {
  db.prepare(`UPDATE invoices SET status = 'PAID', paid_at = datetime('now'),
              updated_at = datetime('now') WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// ── Scheduled jobs ─────────────────────────────────────────────────────────

// Sync invoices from Xero every day at 7am
cron.schedule('0 7 * * *', async () => {
  console.log('[cron] daily sync starting');
  const tenants = db.prepare(`SELECT * FROM tenants WHERE tokens IS NOT NULL`).all();
  for (const t of tenants) await syncOverdueInvoices(t).catch(console.error);
});

// Run chase engine every day at 8am
cron.schedule('0 8 * * *', async () => {
  console.log('[cron] daily chase run starting');
  await runChaseAll().catch(console.error);
});

// ── Start ──────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 PaidUp running at http://localhost:${PORT}`);
  console.log(`   Connect Xero: http://localhost:${PORT}/xero/connect\n`);
});
