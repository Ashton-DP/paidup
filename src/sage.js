/**
 * Sage Business Cloud Accounting — OAuth 2.0 + invoice sync.
 * Mirrors the xero.js pattern so the rest of the codebase treats both the same.
 */

const db = require('./db');

const AUTH_URL  = 'https://www.sageone.com/oauth2/auth/central';
const TOKEN_URL = 'https://oauth.accounting.sage.com/token';
const API_BASE  = 'https://api.accounting.sage.com/v3.1';

const clientId     = () => process.env.SAGE_CLIENT_ID;
const clientSecret = () => process.env.SAGE_CLIENT_SECRET;
const redirectUri  = () => process.env.SAGE_REDIRECT_URI;

function getAuthUrl() {
  if (!clientId()) throw new Error('SAGE_CLIENT_ID not set');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     clientId(),
    redirect_uri:  redirectUri(),
    scope:         'full_access',
    filter:        'apiv3.1',
  });
  return `${AUTH_URL}?${params}`;
}

async function fetchTokens(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), ...params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Sage token ${res.status}: ${data.error_description || data.error || JSON.stringify(data)}`);
  return data;
}

// Sage access tokens expire in 5 minutes — always refresh before API calls.
async function getAccessToken(tenantRow) {
  const tokens = JSON.parse(tenantRow.tokens);
  const fresh = await fetchTokens({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
  await db.run(`UPDATE tenants SET tokens = ? WHERE id = ?`, JSON.stringify(fresh), tenantRow.id);
  return fresh.access_token;
}

async function sageGet(path, accessToken) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Sage API ${path} → ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function handleCallback(code, accountId) {
  const tokens = await fetchTokens({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() });

  // Get the authenticated business name + ID
  const bizData = await sageGet('/businesses', tokens.access_token);
  const biz = (bizData.$items || bizData.items || [])[0] || {};
  const businessId   = String(biz.id || 'unknown');
  const businessName = biz.name || biz.displayed_as || 'My Sage Business';

  // Store Sage tenants using a prefixed ID in xero_tenant_id so the UNIQUE
  // constraint never clashes with real Xero tenant UUIDs.
  const fakeXeroId = `sage_${businessId}`;
  const genId = () => `${Date.now()}_${Math.random().toString(36).slice(2)}`;

  const existing = await db.get(
    `SELECT id FROM tenants WHERE xero_tenant_id = ? AND account_id IS NOT DISTINCT FROM ?`,
    fakeXeroId, accountId || null
  );

  if (!existing) {
    await db.run(
      `INSERT INTO tenants (id, account_id, name, xero_tenant_id, sage_company_id, provider, tokens)
       VALUES (?, ?, ?, ?, ?, 'sage', ?)`,
      genId(), accountId || null, businessName, fakeXeroId, businessId, JSON.stringify(tokens)
    );
  } else {
    await db.run(
      `UPDATE tenants SET tokens = ?, name = ?, sage_company_id = ? WHERE xero_tenant_id = ?`,
      JSON.stringify(tokens), businessName, businessId, fakeXeroId
    );
  }

  console.log(`[sage] connected: ${businessName} (${businessId})`);
  return { businessId, businessName };
}

async function syncOverdueInvoices(tenantRow) {
  const accessToken = await getAccessToken(tenantRow);
  const today = new Date().toISOString().split('T')[0];
  let synced = 0;
  let page = 1;

  while (true) {
    const data = await sageGet(
      `/sales_invoices?items_per_page=200&page=${page}&attributes=contact,outstanding_amount,due_date,invoice_number,currency,status`,
      accessToken
    );

    const items = data.$items || data.items || [];
    if (!items.length) break;

    for (const inv of items) {
      const statusId = inv.status?.id || inv.status || '';
      // Include OUTSTANDING (unpaid) and PART_PAID; skip DRAFT/VOID/PAID
      if (!['OUTSTANDING', 'PART_PAID', 'ACTIVE'].includes(statusId)) continue;
      if (!inv.due_date || inv.due_date >= today) continue; // not yet overdue

      const daysOv = Math.floor((new Date(today) - new Date(inv.due_date)) / 86400000);
      const contact = inv.contact || {};

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
        String(inv.id),
        inv.invoice_number || inv.displayed_as || '',
        contact.displayed_as || contact.name || 'Unknown',
        contact.email || null,
        contact.telephone || contact.mobile_telephone || null,
        inv.outstanding_amount ?? inv.total_amount ?? 0,
        inv.currency?.id || 'ZAR',
        inv.due_date,
        daysOv
      );
      synced++;
    }

    if (!data.$next) break;
    page++;
  }

  console.log(`[sage] synced ${synced} overdue invoices for ${tenantRow.name}`);
  return synced;
}

module.exports = { getAuthUrl, handleCallback, syncOverdueInvoices };
