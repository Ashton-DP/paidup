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
const { runChaseAll, runChaseForTenant, handleReply,
        previewChase, sendChaseForInvoice } = require('./src/chaser');
const { parseReplyIntent } = require('./src/whatsapp');
const { isChasingPaused, setChasingPaused } = require('./src/safety');
const { getAppSettings, setSetting, DEFAULTS } = require('./src/settings');
const { csvToInvoices } = require('./src/csv');
const { daysOverdue } = require('./src/xeroUtils');
const accounts = require('./src/accounts');
const paystack = require('./src/paystack');

const app = express();

// Pick the org to show/operate on FOR THIS ACCOUNT: the one with the most
// overdue invoices, tie-broken by most recently connected.
function activeTenant(accountId) {
  return db.prepare(`
    SELECT t.* FROM tenants t
    LEFT JOIN invoices i ON i.tenant_id = t.id AND i.status = 'OVERDUE'
    WHERE t.account_id IS ?
    GROUP BY t.id
    ORDER BY COUNT(i.id) DESC, t.created_at DESC
    LIMIT 1
  `).get(accountId || null);
}

const genId = () => `${Date.now()}_${Math.random().toString(36).slice(2)}`;

// Manual / CSV invoices attach to the account's active org, or to a local "My
// Business" tenant created on demand — so PaidUp is usable with no Xero.
function targetTenantForManual(accountId) {
  const existing = activeTenant(accountId);
  if (existing) return existing;
  const id = genId();
  db.prepare(`INSERT INTO tenants (id, account_id, name, xero_tenant_id, tokens)
              VALUES (?, ?, 'My Business', ?, NULL)`).run(id, accountId || null, 'local-' + id);
  return db.prepare(`SELECT * FROM tenants WHERE id = ?`).get(id);
}

// Return an invoice only if it belongs to this account (else null → 404).
function ownedInvoice(invoiceId, accountId) {
  return db.prepare(`
    SELECT i.* FROM invoices i JOIN tenants t ON t.id = i.tenant_id
    WHERE i.id = ? AND t.account_id IS ?
  `).get(invoiceId, accountId || null);
}

// Apply a Paystack webhook event to the matching account's subscription.
function handlePaystackEvent(evt) {
  const { event, data } = evt || {};
  if (!event || !data) return;
  const email = data.customer?.email;
  const acc = (email && accounts.findAccountByEmail(email))
    || (data.metadata?.accountId ? accounts.getAccount(data.metadata.accountId) : null);
  if (!acc) { console.warn('[paystack] no account matched for', event); return; }

  if (event === 'charge.success' || event === 'subscription.create') {
    accounts.setSubscription(acc.id, {
      plan: data.metadata?.plan || data.plan?.name?.toLowerCase(),
      status: 'active',
      customerCode: data.customer?.customer_code,
      subscriptionCode: data.subscription_code,
      periodEnd: data.next_payment_date || null,
    });
    console.log('[paystack] activated', acc.email);
  } else if (event === 'invoice.payment_failed') {
    accounts.setSubscription(acc.id, { status: 'past_due' });
  } else if (event === 'subscription.disable' || event === 'subscription.not_renew') {
    accounts.setSubscription(acc.id, { status: 'cancelled' });
  }
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

const AUTH_STYLES = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    background:#0f0f13;color:#e8e8ec;min-height:100vh;display:flex;
    align-items:center;justify-content:center;padding:20px}
  .card{background:#18181f;border:1px solid #2a2a35;border-radius:12px;
    padding:36px 32px;width:360px}
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
  .alt{margin-top:18px;font-size:13px;color:#888;text-align:center}
  .alt a{color:#6c8fff;text-decoration:none}`;

function loginPage(error) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PaidUp — Sign in</title><style>${AUTH_STYLES}</style></head><body>
  <form class="card" method="POST" action="/login">
    <div class="logo">Paid<span>Up</span></div>
    <div class="sub">Sign in to your dashboard</div>
    ${error ? `<div class="err">Incorrect email or password.</div>` : ''}
    <label>Email</label>
    <input type="email" name="email" autofocus required>
    <label>Password</label>
    <input type="password" name="password" required>
    <button type="submit">Sign in</button>
    <div class="alt">No account yet? <a href="/signup">Create one</a></div>
  </form>
</body></html>`;
}

function signupPage(error) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PaidUp — Create account</title><style>${AUTH_STYLES}</style></head><body>
  <form class="card" method="POST" action="/signup">
    <div class="logo">Paid<span>Up</span></div>
    <div class="sub">Start your free trial</div>
    ${error ? `<div class="err">${error}</div>` : ''}
    <label>Business name</label>
    <input type="text" name="business_name" placeholder="e.g. Karoo Coffee Co" autofocus>
    <label>Email</label>
    <input type="email" name="email" required>
    <label>Password</label>
    <input type="password" name="password" placeholder="At least 8 characters" required>
    <button type="submit">Create account</button>
    <div class="alt">Already have an account? <a href="/login">Sign in</a></div>
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
// Per-account auth: the dashboard + API require a logged-in account. The
// landing page and external callbacks (OAuth, webhooks) stay public.
const PUBLIC_PATHS = new Set([
  '/', '/index.html', '/healthz', '/login', '/signup', '/logout', '/api/waitlist',
  '/robots.txt', '/sitemap.xml', '/favicon.svg', '/og.svg',
  '/xero/connect', '/xero/callback', '/xero/webhook', '/twilio/reply',
  '/paystack/webhook',
]);
function requireAuth(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();
  const accountId = req.session && req.session.accountId;
  if (accountId && accounts.getAccount(accountId)) { req.accountId = accountId; return next(); }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'auth required' });
  return res.redirect('/login');
}
app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

// Public health check for the host's uptime probe (no auth).
app.get('/healthz', (req, res) => res.json({ ok: true }));

// The dashboard app (gated by requireAuth above). The marketing landing page
// is served at / from public/index.html by express.static.
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'views', 'dashboard.html')));

// Landing-page waitlist sign-up (public).
app.post('/api/waitlist', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address' });
  }
  db.prepare(`INSERT OR IGNORE INTO waitlist (email) VALUES (?)`).run(email);
  res.json({ ok: true });
});

// ── Auth (accounts) ──────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session?.accountId) return res.redirect('/app');
  res.type('html').send(loginPage(!!req.query.error));
});
app.post('/login', (req, res) => {
  const acc = accounts.verifyLogin(req.body.email, req.body.password);
  if (!acc) return res.redirect('/login?error=1');
  req.session.accountId = acc.id;
  res.redirect('/app');
});
app.get('/signup', (req, res) => {
  if (req.session?.accountId) return res.redirect('/app');
  res.type('html').send(signupPage(req.query.error ? String(req.query.error) : null));
});
app.post('/signup', (req, res) => {
  try {
    const acc = accounts.createAccount({
      email: req.body.email,
      password: req.body.password,
      businessName: req.body.business_name,
      trialEndsAt: new Date(Date.now() + 14 * 86400000).toISOString(),
    });
    req.session.accountId = acc.id;
    res.redirect('/app');
  } catch (e) {
    res.redirect('/signup?error=' + encodeURIComponent(e.message));
  }
});
app.get('/logout', (req, res) => {
  if (req.session) req.session.accountId = null;
  res.redirect('/');
});

// ── Xero OAuth ─────────────────────────────────────────────────────────────

app.get('/xero/connect', async (req, res) => {
  const url = await getAuthUrl();
  res.redirect(url);
});

app.get('/xero/callback', async (req, res) => {
  try {
    const tenant = await handleCallback(
      `${process.env.BASE_URL}/xero/callback?${new URLSearchParams(req.query)}`,
      req.session.accountId);
    req.session.tenantId = tenant.tenantId;
    res.redirect('/app?connected=1');
  } catch (err) {
    console.error('[xero callback] FULL ERROR ↓');
    console.error('  message :', err && err.message);
    console.error('  name    :', err && err.name);
    console.error('  body    :', err && (err.body || err.response?.body || err.data));
    console.error('  stack   :', err && err.stack);
    res.redirect('/app?error=xero_auth_failed');
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

// ── Paystack billing webhook (subscription lifecycle) ──────────────────────

app.post('/paystack/webhook', express.raw({ type: '*/*' }), (req, res) => {
  if (!paystack.verifyWebhook(req.body, req.headers['x-paystack-signature'])) {
    return res.sendStatus(401);
  }
  res.sendStatus(200); // ack fast
  try {
    handlePaystackEvent(JSON.parse(req.body.toString()));
  } catch (err) {
    console.error('[paystack webhook]', err.message);
  }
});

// Paystack redirects the customer back here after checkout (logged in).
app.get('/billing/callback', async (req, res) => {
  try {
    const tx = await paystack.verifyTransaction(req.query.reference);
    if (tx.status === 'success') {
      accounts.setSubscription(req.session.accountId, {
        plan: tx.metadata?.plan,
        status: 'active',
        customerCode: tx.customer?.customer_code,
        periodEnd: tx.paid_at || null,
      });
      return res.redirect('/app?subscribed=1');
    }
  } catch (err) {
    console.error('[billing callback]', err.message);
  }
  res.redirect('/app?billing=failed');
});

// ── Twilio WhatsApp inbound reply ──────────────────────────────────────────

app.post('/twilio/reply', (req, res) => {
  const { From, Body } = req.body;
  const intent = parseReplyIntent(Body);
  // Route the reply to whichever tenant has a matching invoice phone number.
  const key = String(From || '').replace(/\D/g, '').slice(-9);
  const inv = key
    ? db.prepare(`SELECT tenant_id FROM invoices WHERE contact_phone LIKE ?
                  ORDER BY last_chased_at DESC LIMIT 1`).get('%' + key + '%')
    : null;
  if (inv) handleReply({ tenantId: inv.tenant_id, fromNumber: From, body: Body, intent });

  // Twilio expects TwiML response (empty is fine — no auto-reply in MVP)
  res.type('text/xml').send('<Response></Response>');
});

// ── Dashboard API ──────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  const acc = accounts.getAccount(req.accountId);
  const billing = {
    plan: acc.plan, status: acc.subscription_status,
    trial_days_left: accounts.trialDaysLeft(acc), active: accounts.isActive(acc),
  };
  const tenant = activeTenant(req.accountId);
  if (!tenant) return res.json({ connected: false, paused: isChasingPaused(req.accountId), billing });

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
             currency: curRow?.currency || 'ZAR', paused: isChasingPaused(req.accountId),
             billing, stats, invoices, recent });
});

app.get('/api/invoices', (req, res) => {
  const tenant = activeTenant(req.accountId);
  if (!tenant) return res.json([]);
  const rows = db.prepare(`SELECT * FROM invoices WHERE tenant_id = ?
                            ORDER BY days_overdue DESC`).all(tenant.id);
  res.json(rows);
});

app.post('/api/sync', async (req, res) => {
  const tenant = activeTenant(req.accountId);
  if (!tenant) return res.status(400).json({ error: 'Not connected to Xero' });
  try {
    const count = await syncOverdueInvoices(tenant);
    res.json({ synced: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pause', (req, res) => {
  res.json({ paused: setChasingPaused(req.accountId, !!req.body.paused) });
});

// ── Billing (Paystack) ───────────────────────────────────────────────────────
app.get('/api/billing', (req, res) => {
  const acc = accounts.getAccount(req.accountId);
  res.json({
    plan: acc.plan,
    status: acc.subscription_status,
    trial_days_left: accounts.trialDaysLeft(acc),
    trial_ends_at: acc.trial_ends_at,
    active: accounts.isActive(acc),
    current_period_end: acc.current_period_end,
    plans: Object.entries(paystack.PLANS).map(([key, p]) => ({ key, name: p.name, price: p.amount / 100 })),
  });
});

app.post('/api/billing/subscribe', async (req, res) => {
  const acc = accounts.getAccount(req.accountId);
  if (!paystack.PLANS[req.body.plan]) return res.status(400).json({ error: 'Unknown plan' });
  try {
    const r = await paystack.initSubscription({
      email: acc.email, plan: req.body.plan, accountId: acc.id,
      callbackUrl: `${process.env.BASE_URL || ''}/billing/callback`,
    });
    res.json({ authorization_url: r.authorization_url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Business name + chase cadence settings (per account).
app.get('/api/settings', (req, res) => res.json(getAppSettings(req.accountId)));
app.post('/api/settings', (req, res) => {
  for (const k of Object.keys(DEFAULTS)) {
    if (req.body[k] !== undefined) setSetting(req.accountId, k, req.body[k]);
  }
  res.json(getAppSettings(req.accountId));
});

// Add a single invoice manually (no Xero needed).
app.post('/api/invoices/manual', (req, res) => {
  const { contact_name, amount_due, due_date } = req.body;
  const amount = parseFloat(amount_due);
  if (!contact_name || !(amount > 0) || !due_date) {
    return res.status(400).json({ error: 'Name, a positive amount, and a due date are required' });
  }
  const tenant = targetTenantForManual(req.accountId);
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
  const tenant = targetTenantForManual(req.accountId);
  db.transaction(rows => rows.forEach(r => insertManualInvoice(tenant.id, r)))(invoices);
  res.json({ imported: invoices.length, skipped });
});

app.post('/api/chase-now', async (req, res) => {
  if (!accounts.isActive(accounts.getAccount(req.accountId)))
    return res.status(403).json({ error: 'Your trial has ended — subscribe to keep chasing.' });
  const tenant = activeTenant(req.accountId);
  if (!tenant) return res.status(400).json({ error: 'Not connected to Xero' });
  try {
    const count = await runChaseForTenant(tenant);
    res.json({ chased: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Preview the AI message(s) for one invoice without sending.
app.post('/api/invoice/:id/preview', async (req, res) => {
  if (!ownedInvoice(req.params.id, req.accountId)) return res.status(404).json({ error: 'Invoice not found' });
  try { res.json(await previewChase(req.params.id)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Send the chase for one invoice (operator override of the cron cadence).
app.post('/api/invoice/:id/send', async (req, res) => {
  if (!ownedInvoice(req.params.id, req.accountId)) return res.status(404).json({ error: 'Invoice not found' });
  if (!accounts.isActive(accounts.getAccount(req.accountId)))
    return res.status(403).json({ error: 'Your trial has ended — subscribe to keep chasing.' });
  try {
    const r = await sendChaseForInvoice(req.params.id);
    if (!r.sent.length) {
      return res.status(400).json({ error: 'Nothing sent — no contactable channel, or the contact opted out' });
    }
    res.json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/invoice/:id/snooze', (req, res) => {
  if (!ownedInvoice(req.params.id, req.accountId)) return res.status(404).json({ error: 'Invoice not found' });
  const days = parseInt(req.body.days) || 5;
  db.prepare(`UPDATE invoices SET snoozed_until = datetime('now', ?),
              updated_at = datetime('now') WHERE id = ?`)
    .run(`+${days} days`, req.params.id);
  res.json({ ok: true });
});

app.post('/api/invoice/:id/paid', (req, res) => {
  if (!ownedInvoice(req.params.id, req.accountId)) return res.status(404).json({ error: 'Invoice not found' });
  db.prepare(`UPDATE invoices SET status = 'PAID', paid_at = datetime('now'),
              updated_at = datetime('now') WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// Remove a single invoice (and its chase history). Xero-synced ones return on
// the next sync; manual ones are gone for good.
app.delete('/api/invoice/:id', (req, res) => {
  if (!ownedInvoice(req.params.id, req.accountId)) return res.status(404).json({ error: 'Invoice not found' });
  db.transaction(() => {
    db.prepare(`DELETE FROM chase_log WHERE invoice_id = ?`).run(req.params.id);
    db.prepare(`DELETE FROM invoices WHERE id = ?`).run(req.params.id);
  })();
  res.json({ ok: true });
});

// Wipe THIS ACCOUNT's data to a clean slate (its invoices, connections,
// history) — keeps the account itself, its settings and the waitlist.
app.post('/api/reset', (req, res) => {
  const tids = db.prepare(`SELECT id FROM tenants WHERE account_id IS ?`)
    .all(req.accountId || null).map(r => r.id);
  db.transaction(() => {
    for (const tid of tids) {
      db.prepare(`DELETE FROM chase_log WHERE tenant_id = ?`).run(tid);
      db.prepare(`DELETE FROM replies WHERE tenant_id = ?`).run(tid);
      db.prepare(`DELETE FROM suppressions WHERE tenant_id = ?`).run(tid);
      db.prepare(`DELETE FROM invoices WHERE tenant_id = ?`).run(tid);
    }
    db.prepare(`DELETE FROM tenants WHERE account_id IS ?`).run(req.accountId || null);
  })();
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
