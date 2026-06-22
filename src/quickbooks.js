/**
 * QuickBooks Online — OAuth 2.0 + invoice sync.
 * Mirrors the sage.js pattern so the rest of the codebase treats all providers the same.
 */

const db = require('./db');

const AUTH_URL  = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API_BASE  = 'https://quickbooks.api.intuit.com/v3/company';

const clientId     = () => process.env.QBO_CLIENT_ID;
const clientSecret = () => process.env.QBO_CLIENT_SECRET;
const redirectUri  = () => process.env.QBO_REDIRECT_URI;

function getAuthUrl() {
  if (!clientId()) throw new Error('QBO_CLIENT_ID not set');
  const params = new URLSearchParams({
    client_id:     clientId(),
    scope:         'com.intuit.quickbooks.accounting',
    redirect_uri:  redirectUri(),
    response_type: 'code',
    state:         'paidup',
  });
  return `${AUTH_URL}?${params}`;
}

// QBO token endpoint uses HTTP Basic Auth (not body params like Sage)
async function fetchTokens(params) {
  const creds = Buffer.from(`${clientId()}:${clientSecret()}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${creds}`,
      'Accept':        'application/json',
    },
    body: new URLSearchParams({ redirect_uri: redirectUri(), ...params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`QBO token ${res.status}: ${data.error_description || data.error || JSON.stringify(data)}`);
  return data;
}

// Access tokens expire in 3600s — store expires_at and only refresh when needed.
async function getAccessToken(tenantRow) {
  const tokens = JSON.parse(tenantRow.tokens);
  const now = Date.now();
  if (tokens.expires_at && now < tokens.expires_at - 60_000) {
    return tokens.access_token;
  }
  const fresh = await fetchTokens({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
  fresh.expires_at = now + (fresh.expires_in || 3600) * 1000;
  fresh.realm_id   = tokens.realm_id; // carry realmId through refreshes
  await db.run(`UPDATE tenants SET tokens = ? WHERE id = ?`, JSON.stringify(fresh), tenantRow.id);
  return fresh.access_token;
}

async function qboGet(path, realmId, accessToken) {
  const res = await fetch(`${API_BASE}/${realmId}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept:        'application/json',
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`QBO API ${path} → ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function handleCallback(code, realmId, accountId) {
  const tokens = await fetchTokens({ grant_type: 'authorization_code', code });
  tokens.realm_id   = realmId;
  tokens.expires_at = Date.now() + (tokens.expires_in || 3600) * 1000;

  // Get company name
  const info = await qboGet(`/companyinfo/${realmId}?minorversion=65`, realmId, tokens.access_token);
  const company = info.CompanyInfo || {};
  const businessName = company.CompanyName || 'My QuickBooks Business';

  const fakeXeroId = `qbo_${realmId}`;
  const genId = () => `${Date.now()}_${Math.random().toString(36).slice(2)}`;

  const existing = await db.get(
    `SELECT id FROM tenants WHERE xero_tenant_id = ? AND account_id IS NOT DISTINCT FROM ?`,
    fakeXeroId, accountId || null
  );

  if (!existing) {
    await db.run(
      `INSERT INTO tenants (id, account_id, name, xero_tenant_id, sage_company_id, provider, tokens)
       VALUES (?, ?, ?, ?, ?, 'quickbooks', ?)`,
      genId(), accountId || null, businessName, fakeXeroId, realmId, JSON.stringify(tokens)
    );
  } else {
    await db.run(
      `UPDATE tenants SET tokens = ?, name = ?, sage_company_id = ? WHERE xero_tenant_id = ?`,
      JSON.stringify(tokens), businessName, realmId, fakeXeroId
    );
  }

  console.log(`[qbo] connected: ${businessName} (${realmId})`);
  return { realmId, businessName };
}

async function syncOverdueInvoices(tenantRow) {
  const accessToken = await getAccessToken(tenantRow);
  const tokens  = JSON.parse(tenantRow.tokens);
  const realmId = tenantRow.sage_company_id || tokens.realm_id;
  const today   = new Date().toISOString().split('T')[0];
  let synced = 0;
  let offset = 0;
  const pageSize = 200;

  while (true) {
    const query = `SELECT * FROM Invoice WHERE Balance > '0' AND DueDate < '${today}' STARTPOSITION ${offset + 1} MAXRESULTS ${pageSize}`;
    const data  = await qboGet(`/query?query=${encodeURIComponent(query)}&minorversion=65`, realmId, accessToken);
    const items = data.QueryResponse?.Invoice || [];
    if (!items.length) break;

    for (const inv of items) {
      const daysOv = Math.floor((new Date(today) - new Date(inv.DueDate)) / 86400000);

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
          updated_at    = NOW()
      `,
        `${Date.now()}_${Math.random().toString(36).slice(2)}`,
        tenantRow.id,
        String(inv.Id),
        inv.DocNumber || '',
        inv.CustomerRef?.name || 'Unknown',
        inv.BillEmail?.Address || null,
        null, // QBO doesn't expose phone on Invoice — would need a Customer lookup
        inv.Balance ?? 0,
        inv.CurrencyRef?.value || 'ZAR',
        inv.DueDate,
        daysOv
      );
      synced++;
    }

    if (items.length < pageSize) break;
    offset += pageSize;
  }

  console.log(`[qbo] synced ${synced} overdue invoices for ${tenantRow.name}`);
  return synced;
}

module.exports = { getAuthUrl, handleCallback, syncOverdueInvoices };
