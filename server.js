require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cron = require('node-cron');
const path = require('path');

const db = require('./src/db');
const { getAuthUrl, handleCallback, syncOverdueInvoices,
        validateWebhook, markPaid } = require('./src/xero');
const { runChaseAll, runChaseForTenant, handleReply } = require('./src/chaser');
const { parseReplyIntent } = require('./src/whatsapp');
const { isChasingPaused, setChasingPaused } = require('./src/safety');

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

const isProd = process.env.NODE_ENV === 'production';
// Behind a hosting proxy (Render/Heroku/etc.) Express must trust it so secure
// cookies and req.protocol work correctly.
if (isProd) app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
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
