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
const sage = require('./src/sage');
const quickbooks = require('./src/quickbooks');
const { runChaseAll, runChaseForTenant, handleReply,
        previewChase, sendChaseForInvoice } = require('./src/chaser');
const { parseReplyIntent } = require('./src/whatsapp');
const { isChasingPaused, setChasingPaused } = require('./src/safety');
const { getAppSettings, setSetting, DEFAULTS } = require('./src/settings');
const { csvToInvoices } = require('./src/csv');
const { daysOverdue } = require('./src/xeroUtils');
const accounts = require('./src/accounts');
const stripeClient = require('./src/stripe');
const payfast = require('./src/payfast');

const app = express();

// Pick the org to show/operate on FOR THIS ACCOUNT: the one with the most
// overdue invoices, tie-broken by most recently connected.
async function activeTenant(accountId) {
  return db.get(`
    SELECT t.* FROM tenants t
    LEFT JOIN invoices i ON i.tenant_id = t.id AND i.status = 'OVERDUE'
    WHERE t.account_id IS NOT DISTINCT FROM ?
    GROUP BY t.id
    ORDER BY COUNT(i.id) DESC, t.created_at DESC
    LIMIT 1
  `, accountId || null);
}

const genId = () => `${Date.now()}_${Math.random().toString(36).slice(2)}`;

// Manual / CSV invoices attach to the account's active org, or to a local "My
// Business" tenant created on demand — so PaidUp is usable with no Xero.
async function targetTenantForManual(accountId) {
  const existing = await activeTenant(accountId);
  if (existing) return existing;
  const id = genId();
  await db.run(
    `INSERT INTO tenants (id, account_id, name, xero_tenant_id, tokens) VALUES (?, ?, 'My Business', ?, NULL)`,
    id, accountId || null, 'local-' + id
  );
  return db.get(`SELECT * FROM tenants WHERE id = ?`, id);
}

// Return an invoice only if it belongs to this account (else null → 404).
async function ownedInvoice(invoiceId, accountId) {
  return db.get(`
    SELECT i.* FROM invoices i JOIN tenants t ON t.id = i.tenant_id
    WHERE i.id = ? AND t.account_id IS NOT DISTINCT FROM ?
  `, invoiceId, accountId || null);
}

// Apply a Stripe webhook event to the matching account's subscription.
async function handleStripeEvent(evt) {
  const type = evt?.type;
  const obj  = evt?.data?.object;
  if (!type || !obj) return;

  if (type === 'checkout.session.completed') {
    const accountId = obj.metadata?.accountId;
    const acc = accountId ? await accounts.getAccount(accountId) : null;
    if (!acc) { console.warn('[stripe] no account for checkout.session.completed'); return; }
    await accounts.setSubscription(acc.id, {
      plan: obj.metadata?.plan,
      status: 'active',
      customerCode: obj.customer,
      subscriptionCode: obj.subscription,
      periodEnd: null,
    });
    console.log('[stripe] activated', acc.email);

  } else if (type === 'customer.subscription.updated') {
    const acc = await accounts.findByStripeCustomer(obj.customer);
    if (!acc) return;
    const status = obj.status === 'active' ? 'active'
                 : obj.status === 'past_due' ? 'past_due'
                 : obj.status === 'canceled' ? 'cancelled'
                 : obj.status;
    await accounts.setSubscription(acc.id, {
      status,
      periodEnd: obj.current_period_end
        ? new Date(obj.current_period_end * 1000).toISOString() : null,
    });

  } else if (type === 'customer.subscription.deleted') {
    const acc = await accounts.findByStripeCustomer(obj.customer);
    if (!acc) return;
    await accounts.setSubscription(acc.id, { status: 'cancelled' });

  } else if (type === 'invoice.payment_failed') {
    const acc = await accounts.findByStripeCustomer(obj.customer);
    if (!acc) return;
    await accounts.setSubscription(acc.id, { status: 'past_due' });
  }
}

async function insertManualInvoice(tenantId, f) {
  const over = f.due_date ? daysOverdue(f.due_date) : 0;
  await db.run(
    `INSERT INTO invoices
      (id, tenant_id, xero_invoice_id, invoice_number, contact_name, contact_email,
       contact_phone, amount_due, currency, due_date, days_overdue, status, chase_stage)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OVERDUE', 0)`,
    genId(), tenantId, 'manual-' + genId(), f.invoice_number || null,
    f.contact_name || 'Unknown', f.contact_email || null, f.contact_phone || null,
    f.amount_due, (f.currency || 'ZAR').toUpperCase(), f.due_date, over
  );
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
    <div class="alt" style="margin-top:16px;font-size:11px;color:#555">
      <a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms &amp; Conditions</a>
    </div>
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
    <div class="alt" style="margin-top:16px;font-size:11px;color:#555">
      By signing up you agree to our <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>.
    </div>
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
  '/sage/connect', '/sage/callback',
  '/quickbooks/connect', '/quickbooks/callback',
  '/stripe/webhook',
  '/billing/success', '/billing/cancel',
  '/privacy', '/terms',
  '/pay/success', '/pay/cancel', '/payfast/notify',
]);
async function requireAuth(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();
  const accountId = req.session && req.session.accountId;
  if (accountId && await accounts.getAccount(accountId)) { req.accountId = accountId; return next(); }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'auth required' });
  return res.redirect('/login');
}
app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

// Public health check for the host's uptime probe (no auth).
app.get('/healthz', (req, res) => res.json({ ok: true }));

// The dashboard app (gated by requireAuth above). The marketing landing page
// is served at / from public/index.html by express.static.
app.get('/app',     (req, res) => res.sendFile(path.join(__dirname, 'views', 'dashboard.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'views', 'privacy.html')));
app.get('/terms',   (req, res) => res.sendFile(path.join(__dirname, 'views', 'terms.html')));

// Landing-page waitlist sign-up (public).
app.post('/api/waitlist', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address' });
  }
  await db.run(`INSERT INTO waitlist (email) VALUES (?) ON CONFLICT DO NOTHING`, email);
  res.json({ ok: true });
});

// ── Auth (accounts) ──────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session?.accountId) return res.redirect('/app');
  res.type('html').send(loginPage(!!req.query.error));
});
app.post('/login', async (req, res) => {
  const acc = await accounts.verifyLogin(req.body.email, req.body.password);
  if (!acc) return res.redirect('/login?error=1');
  req.session.accountId = acc.id;
  res.redirect('/app');
});
app.get('/signup', (req, res) => {
  if (req.session?.accountId) return res.redirect('/app');
  res.type('html').send(signupPage(req.query.error ? String(req.query.error) : null));
});
app.post('/signup', async (req, res) => {
  try {
    const acc = await accounts.createAccount({
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

// ── Sage Business Cloud OAuth ─────────────────────────────────────────────

app.get('/sage/connect', (req, res) => {
  try {
    res.redirect(sage.getAuthUrl());
  } catch (err) {
    res.redirect('/app?error=sage_not_configured');
  }
});

app.get('/sage/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect('/app?error=sage_auth_failed');
  try {
    await sage.handleCallback(code, req.session.accountId);
    res.redirect('/app?connected=1');
  } catch (err) {
    console.error('[sage callback]', err.message);
    res.redirect('/app?error=sage_auth_failed');
  }
});

// ── QuickBooks Online OAuth ───────────────────────────────────────────────

app.get('/quickbooks/connect', (req, res) => {
  try {
    res.redirect(quickbooks.getAuthUrl());
  } catch (err) {
    res.redirect('/app?error=qbo_not_configured');
  }
});

app.get('/quickbooks/callback', async (req, res) => {
  const { code, realmId } = req.query;
  if (!code || !realmId) return res.redirect('/app?error=qbo_auth_failed');
  try {
    await quickbooks.handleCallback(code, realmId, req.session.accountId);
    res.redirect('/app?connected=1');
  } catch (err) {
    console.error('[qbo callback]', err.message);
    res.redirect('/app?error=qbo_auth_failed');
  }
});

// ── PayFast payment portal ────────────────────────────────────────────────

function payPage(body) {
  const fs = require('fs');
  const tmpl = fs.readFileSync(path.join(__dirname, 'views/pay.html'), 'utf8');
  return tmpl.replace('{{BODY}}', body);
}

app.get('/pay/success', (req, res) => {
  res.send(payPage(`
    <div class="success-msg">
      <div class="icon">✅</div>
      <h2>Payment received!</h2>
      <p>Thank you — your payment is being processed.<br>You'll receive a confirmation shortly.</p>
    </div>`));
});

app.get('/pay/cancel', (req, res) => {
  res.send(payPage(`
    <div class="cancel-msg">
      <div class="icon">↩️</div>
      <h2>Payment cancelled</h2>
      <p>No payment was taken. If you'd like to pay, click the link in your original reminder.</p>
    </div>`));
});

app.get('/pay/:token/:invoiceId', async (req, res) => {
  const { token, invoiceId } = req.params;
  if (!payfast.verifyToken(invoiceId, token)) return res.status(404).send('Invalid link');
  const invoice = await db.get(`SELECT i.*, t.name as tenant_name FROM invoices i JOIN tenants t ON t.id = i.tenant_id WHERE i.id = ?`, invoiceId);
  if (!invoice || invoice.status === 'PAID') {
    return res.send(payPage(`<div class="success-msg"><div class="icon">✅</div><h2>Already paid</h2><p>This invoice has been settled. Thank you!</p></div>`));
  }
  if (!payfast.isConfigured()) return res.status(503).send('Payment processing not yet configured');

  const params = payfast.buildPaymentParams(invoice, invoice.tenant_name);
  const fields = Object.entries(params).map(([k, v]) =>
    `<input type="hidden" name="${k}" value="${String(v).replace(/"/g, '&quot;')}">`).join('\n');

  const fmt = (n, c) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: c || 'ZAR' }).format(Number(n));

  res.send(payPage(`
    <div class="card-header">
      <div class="biz">${invoice.tenant_name}</div>
      <div class="sub">Secure invoice payment</div>
    </div>
    <div class="card-body">
      <div class="label">Client</div><div class="value">${invoice.contact_name}</div>
      <div class="label">Invoice</div><div class="value">${invoice.invoice_number || invoice.id}</div>
      <div class="label">Due date</div><div class="value">${invoice.due_date}</div>
      <div class="amount-box">
        <div class="amt">${fmt(invoice.amount_due, invoice.currency)}</div>
        <div class="amt-label">Amount due</div>
      </div>
      <form method="POST" action="${payfast.PAYFAST_URL}" id="pf-form">
        ${fields}
        <button type="submit" class="pay-btn">Pay securely →</button>
      </form>
      <div class="secure">🔒 Secured by PayFast · SSL encrypted</div>
      <p class="note">By paying you confirm this amount is correct. For queries reply to the reminder message or contact ${invoice.tenant_name} directly.</p>
    </div>`));
});

// PayFast ITN (Instant Transaction Notification) — marks invoice as paid
app.post('/payfast/notify', express.urlencoded({ extended: false }), async (req, res) => {
  res.sendStatus(200); // must respond 200 immediately

  if (!payfast.validateNotify(req.body)) {
    console.warn('[payfast] invalid notify signature');
    return;
  }
  if (req.body.payment_status !== 'COMPLETE') return;

  const invoiceId = req.body.m_payment_id;
  if (!invoiceId) return;

  await db.run(
    `UPDATE invoices SET status = 'PAID', paid_at = NOW(), updated_at = NOW() WHERE id = ? AND status = 'OVERDUE'`,
    invoiceId
  );
  console.log(`[payfast] invoice ${invoiceId} marked PAID`);
});

// ── Analytics ─────────────────────────────────────────────────────────────

app.get('/api/analytics', async (req, res) => {
  try {
    const tenant = await activeTenant(req.accountId);
    if (!tenant) return res.json({ connected: false });

    const stats = await db.get(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'PAID')    AS paid_count,
        COUNT(*) FILTER (WHERE status = 'OVERDUE') AS overdue_count,
        COALESCE(SUM(amount_due) FILTER (WHERE status = 'PAID'), 0)    AS recovered,
        COALESCE(SUM(amount_due) FILTER (WHERE status = 'OVERDUE'), 0) AS outstanding,
        COALESCE(AVG(
          EXTRACT(EPOCH FROM (paid_at - created_at)) / 86400
        ) FILTER (WHERE status = 'PAID' AND paid_at IS NOT NULL), 0)   AS avg_days_to_pay
      FROM invoices WHERE tenant_id = ?
    `, tenant.id);

    const flagged = await db.all(`
      SELECT * FROM invoices
      WHERE tenant_id = ? AND debt_collect_flagged = TRUE AND status = 'OVERDUE'
      ORDER BY days_overdue DESC
    `, tenant.id);

    const topDebtors = await db.all(`
      SELECT contact_name, SUM(amount_due) AS total_owed, COUNT(*) AS invoice_count
      FROM invoices WHERE tenant_id = ? AND status = 'OVERDUE'
      GROUP BY contact_name ORDER BY total_owed DESC LIMIT 5
    `, tenant.id);

    res.json({ connected: true, stats, flagged, topDebtors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Debt collection referral email ────────────────────────────────────────

app.post('/api/refer-to-collector', async (req, res) => {
  try {
    const invoice = await ownedInvoice(req.body.invoiceId, req.accountId);
    if (!invoice) return res.status(404).json({ error: 'Not found' });
    const account = await accounts.getAccount(req.accountId);
    const settings = await (require('./src/settings')).getAppSettings(req.accountId);
    const biz = settings.business_name || 'Your business';
    const fmt = n => `R${Number(n).toLocaleString('en-ZA', { minimumFractionDigits: 2 })}`;

    const { sendChaseEmail } = require('./src/email');
    await sendChaseEmail({
      to: account.email,
      toName: biz,
      rawMessage: `Subject: Debt Collection Referral — Invoice ${invoice.invoice_number}

Hi,

The following invoice has been flagged for debt collection referral after ${invoice.days_overdue} days overdue with no payment received.

Client: ${invoice.contact_name}
Invoice: ${invoice.invoice_number}
Amount: ${fmt(invoice.amount_due)}
Due date: ${invoice.due_date}
Email: ${invoice.contact_email || 'N/A'}
Phone: ${invoice.contact_phone || 'N/A'}

You can forward this to your debt collection agency of choice.

— PaidUp`,
      invoiceNumber: invoice.invoice_number,
      senderName: 'PaidUp',
    });

    await db.run(`UPDATE invoices SET updated_at = NOW() WHERE id = ?`, invoice.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Xero webhook (invoice paid / updated) ──────────────────────────────────

app.post('/xero/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  const sig = req.headers['x-xero-signature'];
  if (!validateWebhook(req.body, sig)) return res.sendStatus(401);

  res.sendStatus(200); // must respond quickly

  try {
    const events = JSON.parse(req.body.toString()).events || [];
    for (const ev of events) {
      if (ev.eventType === 'UPDATE' && ev.eventCategory === 'INVOICE') {
        const tenant = await db.get(`SELECT * FROM tenants WHERE xero_tenant_id = ?`, ev.tenantId);
        if (tenant) await markPaid(tenant.id, ev.resourceId);
      }
    }
  } catch (err) {
    console.error('[xero webhook]', err.message);
  }
});

// ── Stripe billing webhook (subscription lifecycle) ────────────────────────

app.post('/stripe/webhook', express.raw({ type: '*/*' }), (req, res) => {
  const evt = stripeClient.verifyWebhook(req.body, req.headers['stripe-signature']);
  if (!evt) return res.sendStatus(401);
  res.sendStatus(200); // ack immediately
  handleStripeEvent(evt).catch(err => console.error('[stripe webhook]', err.message));
});

// Stripe redirects here after a successful checkout.
app.get('/billing/success', async (req, res) => {
  // Webhook handles the actual activation — just show a success page.
  res.redirect('/app?subscribed=1');
});

app.get('/billing/cancel', (req, res) => res.redirect('/app?billing=cancelled'));

// ── Twilio WhatsApp inbound reply ──────────────────────────────────────────

app.post('/twilio/reply', async (req, res) => {
  const { From, Body } = req.body;
  const intent = parseReplyIntent(Body);
  // Route the reply to whichever tenant has a matching invoice phone number.
  const key = String(From || '').replace(/\D/g, '').slice(-9);
  const inv = key
    ? await db.get(
        `SELECT tenant_id FROM invoices WHERE contact_phone LIKE ? ORDER BY last_chased_at DESC LIMIT 1`,
        '%' + key + '%'
      )
    : null;
  if (inv) await handleReply({ tenantId: inv.tenant_id, fromNumber: From, body: Body, intent });

  // Twilio expects TwiML response (empty is fine — no auto-reply in MVP)
  res.type('text/xml').send('<Response></Response>');
});

// ── Dashboard API ──────────────────────────────────────────────────────────

app.get('/api/status', async (req, res) => {
  const acc = await accounts.getAccount(req.accountId);
  const billing = {
    plan: acc.plan, status: acc.subscription_status,
    trial_days_left: accounts.trialDaysLeft(acc), active: accounts.isActive(acc),
  };
  const tenant = await activeTenant(req.accountId);
  if (!tenant) return res.json({ connected: false, paused: await isChasingPaused(req.accountId), billing });

  const stats = await db.get(`
    SELECT
      COUNT(*)                                             AS total_overdue,
      COALESCE(SUM(amount_due), 0)                         AS total_value,
      COUNT(CASE WHEN status = 'PAID' THEN 1 END)          AS paid_count,
      COALESCE(SUM(CASE WHEN status = 'PAID' THEN amount_due END), 0) AS recovered,
      COUNT(CASE WHEN chase_stage >= 1 THEN 1 END)         AS chased_count
    FROM invoices WHERE tenant_id = ?
  `, tenant.id);

  const invoices = await db.all(`
    SELECT * FROM invoices WHERE tenant_id = ? AND status = 'OVERDUE'
    ORDER BY days_overdue DESC LIMIT 50
  `, tenant.id);

  const recent = await db.all(`
    SELECT cl.*, i.invoice_number, i.contact_name FROM chase_log cl
    JOIN invoices i ON i.id = cl.invoice_id
    WHERE cl.tenant_id = ? ORDER BY cl.sent_at DESC LIMIT 20
  `, tenant.id);

  // Most common currency among this org's overdue invoices, for stat totals.
  const curRow = await db.get(`
    SELECT currency, COUNT(*) c FROM invoices
    WHERE tenant_id = ? AND status = 'OVERDUE'
    GROUP BY currency ORDER BY c DESC LIMIT 1
  `, tenant.id);

  res.json({ connected: true, tenant: tenant.name,
             currency: curRow?.currency || 'ZAR', paused: await isChasingPaused(req.accountId),
             billing, stats, invoices, recent });
});

app.get('/api/invoices', async (req, res) => {
  const tenant = await activeTenant(req.accountId);
  if (!tenant) return res.json([]);
  const rows = await db.all(
    `SELECT * FROM invoices WHERE tenant_id = ? ORDER BY days_overdue DESC`,
    tenant.id
  );
  res.json(rows);
});

app.post('/api/sync', async (req, res) => {
  const tenant = await activeTenant(req.accountId);
  if (!tenant) return res.status(400).json({ error: 'Not connected to an accounting provider' });
  try {
    const count = tenant.provider === 'sage'
      ? await sage.syncOverdueInvoices(tenant)
      : tenant.provider === 'quickbooks'
      ? await quickbooks.syncOverdueInvoices(tenant)
      : await syncOverdueInvoices(tenant);
    res.json({ synced: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pause', async (req, res) => {
  res.json({ paused: await setChasingPaused(req.accountId, !!req.body.paused) });
});

// ── Billing (Stripe) ─────────────────────────────────────────────────────────
app.get('/api/billing', async (req, res) => {
  const acc = await accounts.getAccount(req.accountId);
  res.json({
    plan: acc.plan,
    status: acc.subscription_status,
    trial_days_left: accounts.trialDaysLeft(acc),
    trial_ends_at: acc.trial_ends_at,
    active: accounts.isActive(acc),
    current_period_end: acc.current_period_end,
    plans: Object.entries(stripeClient.PLANS).map(([key, p]) => ({ key, name: p.name, price: p.amount / 100 })),
  });
});

app.post('/api/billing/subscribe', async (req, res) => {
  const acc = await accounts.getAccount(req.accountId);
  if (!stripeClient.PLANS[req.body.plan]) return res.status(400).json({ error: 'Unknown plan' });
  try {
    const base = process.env.BASE_URL || '';
    const session = await stripeClient.createCheckoutSession({
      email: acc.email, plan: req.body.plan, accountId: acc.id,
      successUrl: `${base}/billing/success`,
      cancelUrl:  `${base}/billing/cancel`,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Business name + chase cadence settings (per account).
app.get('/api/settings', async (req, res) => res.json(await getAppSettings(req.accountId)));
app.post('/api/settings', async (req, res) => {
  for (const k of Object.keys(DEFAULTS)) {
    if (req.body[k] !== undefined) await setSetting(req.accountId, k, req.body[k]);
  }
  res.json(await getAppSettings(req.accountId));
});

// Add a single invoice manually (no Xero needed).
app.post('/api/invoices/manual', async (req, res) => {
  const { contact_name, amount_due, due_date } = req.body;
  const amount = parseFloat(amount_due);
  if (!contact_name || !(amount > 0) || !due_date) {
    return res.status(400).json({ error: 'Name, a positive amount, and a due date are required' });
  }
  const tenant = await targetTenantForManual(req.accountId);
  await insertManualInvoice(tenant.id, {
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
app.post('/api/invoices/import', async (req, res) => {
  const { invoices, skipped } = csvToInvoices(req.body.csv || '');
  if (!invoices.length) {
    return res.status(400).json({ error: 'No valid rows found (need name, amount, due date)', skipped });
  }
  const tenant = await targetTenantForManual(req.accountId);
  for (const r of invoices) await insertManualInvoice(tenant.id, r);
  res.json({ imported: invoices.length, skipped });
});

app.post('/api/chase-now', async (req, res) => {
  if (!accounts.isActive(await accounts.getAccount(req.accountId)))
    return res.status(403).json({ error: 'Your trial has ended — subscribe to keep chasing.' });
  const tenant = await activeTenant(req.accountId);
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
  if (!await ownedInvoice(req.params.id, req.accountId)) return res.status(404).json({ error: 'Invoice not found' });
  try { res.json(await previewChase(req.params.id)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Send the chase for one invoice (operator override of the cron cadence).
app.post('/api/invoice/:id/send', async (req, res) => {
  if (!await ownedInvoice(req.params.id, req.accountId)) return res.status(404).json({ error: 'Invoice not found' });
  if (!accounts.isActive(await accounts.getAccount(req.accountId)))
    return res.status(403).json({ error: 'Your trial has ended — subscribe to keep chasing.' });
  try {
    const r = await sendChaseForInvoice(req.params.id);
    if (!r.sent.length) {
      const detail = r.errors && r.errors.length ? r.errors.join('; ') : 'no contactable channel, or the contact opted out';
      return res.status(400).json({ error: `Nothing sent — ${detail}` });
    }
    res.json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/invoice/:id/snooze', async (req, res) => {
  if (!await ownedInvoice(req.params.id, req.accountId)) return res.status(404).json({ error: 'Invoice not found' });
  const days = parseInt(req.body.days) || 5;
  await db.run(
    `UPDATE invoices SET snoozed_until = NOW() + INTERVAL '${days} days', updated_at = NOW() WHERE id = ?`,
    req.params.id
  );
  res.json({ ok: true });
});

app.post('/api/invoice/:id/paid', async (req, res) => {
  if (!await ownedInvoice(req.params.id, req.accountId)) return res.status(404).json({ error: 'Invoice not found' });
  await db.run(
    `UPDATE invoices SET status = 'PAID', paid_at = NOW(), updated_at = NOW() WHERE id = ?`,
    req.params.id
  );
  res.json({ ok: true });
});

// Remove a single invoice (and its chase history). Xero-synced ones return on
// the next sync; manual ones are gone for good.
app.delete('/api/invoice/:id', async (req, res) => {
  if (!await ownedInvoice(req.params.id, req.accountId)) return res.status(404).json({ error: 'Invoice not found' });
  await db.run(`DELETE FROM chase_log WHERE invoice_id = ?`, req.params.id);
  await db.run(`DELETE FROM invoices WHERE id = ?`, req.params.id);
  res.json({ ok: true });
});

// Wipe THIS ACCOUNT's data to a clean slate (its invoices, connections,
// history) — keeps the account itself, its settings and the waitlist.
app.post('/api/reset', async (req, res) => {
  const tids = (await db.all(
    `SELECT id FROM tenants WHERE account_id IS NOT DISTINCT FROM ?`,
    req.accountId || null
  )).map(r => r.id);
  for (const tid of tids) {
    await db.run(`DELETE FROM chase_log WHERE tenant_id = ?`, tid);
    await db.run(`DELETE FROM replies WHERE tenant_id = ?`, tid);
    await db.run(`DELETE FROM suppressions WHERE tenant_id = ?`, tid);
    await db.run(`DELETE FROM invoices WHERE tenant_id = ?`, tid);
  }
  await db.run(
    `DELETE FROM tenants WHERE account_id IS NOT DISTINCT FROM ?`,
    req.accountId || null
  );
  res.json({ ok: true });
});

// ── Scheduled jobs ─────────────────────────────────────────────────────────

// Sync invoices from all connected providers every day at 7am
cron.schedule('0 7 * * *', async () => {
  console.log('[cron] daily sync starting');
  const tenants = await db.all(`SELECT * FROM tenants WHERE tokens IS NOT NULL`);
  for (const t of tenants) {
    const fn = t.provider === 'sage' ? sage.syncOverdueInvoices
             : t.provider === 'quickbooks' ? quickbooks.syncOverdueInvoices
             : syncOverdueInvoices;
    await fn(t).catch(console.error);
  }
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
