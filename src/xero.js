const { XeroClient } = require('xero-node');
const db = require('./db');
const { daysOverdue, toDateOnly, assemblePhone } = require('./xeroUtils');

const xero = new XeroClient({
  clientId: process.env.XERO_CLIENT_ID,
  clientSecret: process.env.XERO_CLIENT_SECRET,
  redirectUris: [process.env.XERO_REDIRECT_URI],
  // Xero granular scopes (apps created on/after 2 Mar 2026 cannot use the
  // deprecated broad `accounting.transactions` scope). `accounting.invoices.read`
  // is the granular replacement for reading invoices.
  scopes: ['openid', 'profile', 'email', 'accounting.invoices.read',
           'accounting.contacts.read', 'offline_access'],
});

// ── Token persistence ──────────────────────────────────────────────────────

async function saveTokens(tenantId, tokenSet) {
  await db.run(
    `UPDATE tenants SET tokens = ? WHERE xero_tenant_id = ?`,
    JSON.stringify(tokenSet), tenantId
  );
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
  await saveTokens(tenantDbRow.xero_tenant_id, fresh);
  return xero;
}

// ── OAuth flow helpers ─────────────────────────────────────────────────────

async function getAuthUrl() {
  const url = await xero.buildConsentUrl();
  return url;
}

async function handleCallback(url, accountId) {
  let tokenSet;
  try {
    // Note: `url` carries the one-time OAuth `code` — never log it.
    tokenSet = await xero.apiCallback(url);
  } catch (e) {
    console.error('[handleCallback] token exchange failed:', String(e),
      '| body:', e && (e.body || e.response?.body || e.data));
    throw e;
  }
  try {
    // `false` = skip the per-org Organisation API lookup, which needs
    // accounting.settings.read. The /connections endpoint still returns
    // tenantId + tenantName, which is all we use.
    await xero.updateTenants(false);
    console.log('[handleCallback] updateTenants OK, count =', (xero.tenants || []).length);
  } catch (e) {
    console.error('[handleCallback] updateTenants threw:', typeof e, '|', String(e));
    console.error('[handleCallback] updateTenants err.body =', e && (e.body || e.response?.body));
    throw e;
  }
  const tenants = xero.tenants || [];
  if (!tenants.length) throw new Error('No Xero organisation was attached to this connection');

  // A single auth can grant access to multiple orgs. Upsert them all — the
  // same token set works for every connected org (the xero-tenant-id header
  // selects which one we read).
  for (const t of tenants) {
    // Scope to this account so one account can't hijack another's connection.
    const existing = await db.get(
      `SELECT id FROM tenants WHERE xero_tenant_id = ? AND account_id IS NOT DISTINCT FROM ?`,
      t.tenantId, accountId || null
    );
    if (!existing) {
      await db.run(
        `INSERT INTO tenants (id, account_id, name, xero_tenant_id, tokens) VALUES (?, ?, ?, ?, ?)`,
        `${Date.now()}_${Math.random().toString(36).slice(2)}`,
        accountId || null,
        t.tenantName,
        t.tenantId,
        JSON.stringify(tokenSet)
      );
    } else {
      await saveTokens(t.tenantId, tokenSet);
    }
  }
  console.log('[handleCallback] stored orgs:', tenants.map(t => t.tenantName).join(', '));
  return tenants[0];
}

// ── Invoice sync ───────────────────────────────────────────────────────────

// The invoice-LIST endpoint only returns a summary contact (id + name) — it
// does NOT include email or phones. We must fetch the full contact record to
// get the channels we chase on. Cached per-sync so each contact is fetched once.
async function fetchContactDetails(client, xeroTenantId, contactId, cache) {
  if (cache.has(contactId)) return cache.get(contactId);
  let info = { email: null, phone: null };
  try {
    const r = await client.accountingApi.getContact(xeroTenantId, contactId);
    const c = (r.body.contacts || [])[0];
    if (c) {
      info.email = c.emailAddress || null;
      info.phone = assemblePhone(c.phones);
    }
  } catch (e) {
    console.error('[xero] contact fetch failed for', contactId, '-', e.message || String(e));
  }
  cache.set(contactId, info);
  return info;
}

async function syncOverdueInvoices(tenantRow) {
  const client = await loadClient(tenantRow);
  const xeroTenantId = tenantRow.xero_tenant_id;

  const today = new Date().toISOString().split('T')[0];
  const response = await client.accountingApi.getInvoices(
    xeroTenantId,
    undefined,       // ifModifiedSince
    `Type=="ACCREC" AND Status=="AUTHORISED" AND DueDate<DateTime(${today.replace(/-/g, ',')})`,
    'DueDate ASC', undefined, undefined, undefined,
    ['AUTHORISED'],
    undefined, undefined, undefined,
    100
  );

  const invoices = response.body.invoices || [];
  const contactCache = new Map();
  let synced = 0;

  for (const inv of invoices) {
    const contactId = inv.contact?.contactID;
    const details = contactId
      ? await fetchContactDetails(client, xeroTenantId, contactId, contactCache)
      : { email: null, phone: null };

    await db.run(`
      INSERT INTO invoices
        (id, tenant_id, xero_invoice_id, invoice_number, contact_name,
         contact_email, contact_phone, amount_due, currency, due_date,
         days_overdue, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OVERDUE')
      ON CONFLICT(tenant_id, xero_invoice_id) DO UPDATE SET
        days_overdue  = excluded.days_overdue,
        amount_due    = excluded.amount_due,
        contact_email = excluded.contact_email,
        contact_phone = excluded.contact_phone,
        updated_at    = NOW()
    `,
      `${Date.now()}_${Math.random().toString(36).slice(2)}`,
      tenantRow.id,
      inv.invoiceID,
      inv.invoiceNumber,
      inv.contact?.name || 'Unknown',
      details.email,
      details.phone,
      inv.amountDue,
      inv.currencyCode || 'ZAR',
      toDateOnly(inv.dueDate) || today,
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

async function markPaid(tenantId, xeroInvoiceId) {
  await db.run(
    `UPDATE invoices SET status = 'PAID', paid_at = NOW(), updated_at = NOW()
     WHERE tenant_id = ? AND xero_invoice_id = ?`,
    tenantId, xeroInvoiceId
  );
}

module.exports = { xero, getAuthUrl, handleCallback, syncOverdueInvoices,
                   validateWebhook, markPaid };
