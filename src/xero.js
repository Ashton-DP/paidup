const { XeroClient } = require('xero-node');
const db = require('./db');

const xero = new XeroClient({
  clientId: process.env.XERO_CLIENT_ID,
  clientSecret: process.env.XERO_CLIENT_SECRET,
  redirectUris: [process.env.XERO_REDIRECT_URI],
  scopes: ['openid', 'profile', 'email', 'accounting.transactions.read',
           'accounting.contacts.read', 'offline_access'],
});

// ── Token persistence ──────────────────────────────────────────────────────

function saveTokens(tenantId, tokenSet) {
  db.prepare(`UPDATE tenants SET tokens = ? WHERE xero_tenant_id = ?`)
    .run(JSON.stringify(tokenSet), tenantId);
}

async function loadClient(tenantDbRow) {
  const tokens = JSON.parse(tenantDbRow.tokens);
  await xero.setTokenSet(tokens);
  await xero.refreshWithRefreshToken(
    process.env.XERO_CLIENT_ID,
    process.env.XERO_CLIENT_SECRET,
    tokens.refresh_token
  );
  const fresh = await xero.readTokenSet();
  saveTokens(tenantDbRow.xero_tenant_id, fresh);
  return xero;
}

// ── OAuth flow helpers ─────────────────────────────────────────────────────

async function getAuthUrl() {
  const url = await xero.buildConsentUrl();
  return url;
}

async function handleCallback(url) {
  const tokenSet = await xero.apiCallback(url);
  await xero.updateTenants();
  const tenant = xero.tenants[0];
  const existing = db.prepare(`SELECT id FROM tenants WHERE xero_tenant_id = ?`)
    .get(tenant.tenantId);

  if (!existing) {
    db.prepare(`INSERT INTO tenants (id, name, xero_tenant_id, tokens)
                VALUES (?, ?, ?, ?)`)
      .run(
        `${Date.now()}_${Math.random().toString(36).slice(2)}`,
        tenant.tenantName,
        tenant.tenantId,
        JSON.stringify(tokenSet)
      );
  } else {
    saveTokens(tenant.tenantId, tokenSet);
  }
  return tenant;
}

// ── Invoice sync ───────────────────────────────────────────────────────────

function daysOverdue(dueDateStr) {
  const due = new Date(dueDateStr);
  const now = new Date();
  return Math.max(0, Math.floor((now - due) / 86400000));
}

async function syncOverdueInvoices(tenantRow) {
  const client = await loadClient(tenantRow);
  const xeroTenantId = tenantRow.xero_tenant_id;

  const today = new Date().toISOString().split('T')[0];
  const response = await client.accountingApi.getInvoices(
    xeroTenantId,
    undefined,       // ifModifiedSince
    `Type=="ACCREC" AND Status=="AUTHORISED" AND DueDate<DateTime(${today.replace(/-/g, ',')})`,
    undefined, undefined, undefined, undefined,
    ['AUTHORISED'],
    undefined, undefined, undefined,
    100
  );

  const invoices = response.body.invoices || [];
  let synced = 0;

  for (const inv of invoices) {
    if (!inv.contact?.emailAddress && !inv.contact?.phones?.length) continue;

    const phone = inv.contact.phones?.find(p => p.phoneType === 'MOBILE')?.phoneNumber
                || inv.contact.phones?.[0]?.phoneNumber || null;

    const cleanPhone = phone ? phone.replace(/\s+/g, '').replace(/^0/, '+27') : null;

    db.prepare(`
      INSERT INTO invoices
        (id, tenant_id, xero_invoice_id, invoice_number, contact_name,
         contact_email, contact_phone, amount_due, currency, due_date,
         days_overdue, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OVERDUE')
      ON CONFLICT(tenant_id, xero_invoice_id) DO UPDATE SET
        days_overdue = excluded.days_overdue,
        amount_due   = excluded.amount_due,
        updated_at   = datetime('now')
    `).run(
      `${Date.now()}_${Math.random().toString(36).slice(2)}`,
      tenantRow.id,
      inv.invoiceID,
      inv.invoiceNumber,
      inv.contact?.name || 'Unknown',
      inv.contact?.emailAddress || null,
      cleanPhone,
      inv.amountDue,
      inv.currencyCode || 'ZAR',
      inv.dueDate?.split('T')[0] || today,
      daysOverdue(inv.dueDate)
    );
    synced++;
  }

  console.log(`[xero] synced ${synced} overdue invoices for ${tenantRow.name}`);
  return synced;
}

// ── Webhook validation ─────────────────────────────────────────────────────

const crypto = require('crypto');

function validateWebhook(rawBody, signatureHeader) {
  const key = process.env.XERO_WEBHOOK_KEY;
  if (!key) return false;
  const hmac = crypto.createHmac('sha256', key)
    .update(rawBody).digest('base64');
  return hmac === signatureHeader;
}

// ── Mark invoice paid (called on webhook or manual) ────────────────────────

function markPaid(tenantId, xeroInvoiceId) {
  db.prepare(`UPDATE invoices SET status = 'PAID', paid_at = datetime('now'),
              updated_at = datetime('now')
              WHERE tenant_id = ? AND xero_invoice_id = ?`)
    .run(tenantId, xeroInvoiceId);
}

module.exports = { xero, getAuthUrl, handleCallback, syncOverdueInvoices,
                   validateWebhook, markPaid };
