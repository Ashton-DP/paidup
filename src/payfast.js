/**
 * PayFast payment link generation + webhook validation.
 * Generates a /pay/:token/:invoiceId URL included in every chase message.
 * When the client pays, PayFast POSTs to /payfast/notify — we mark the invoice paid.
 */

const crypto = require('crypto');
const { getSetting } = require('./settings');

const PAYFAST_URL = process.env.PAYFAST_SANDBOX === 'true'
  ? 'https://sandbox.payfast.co.za/eng/process'
  : 'https://www.payfast.co.za/eng/process';

const appUrl      = () => process.env.APP_URL || 'https://paid-up.co.za';
const tokenSecret = () => process.env.PAY_TOKEN_SECRET || process.env.SESSION_SECRET || 'paidup-pay-secret';

// Per-account PayFast credentials (stored in settings table)
async function getCredentials(accountId) {
  const [id, key, pass] = await Promise.all([
    getSetting(accountId, 'payfast_merchant_id'),
    getSetting(accountId, 'payfast_merchant_key'),
    getSetting(accountId, 'payfast_passphrase'),
  ]);
  return { merchantId: id || '', merchantKey: key || '', passphrase: pass || '' };
}

// Derive a short HMAC token from the invoice ID — no DB column needed.
function payToken(invoiceId) {
  return crypto.createHmac('sha256', tokenSecret()).update(String(invoiceId)).digest('hex').slice(0, 32);
}

function verifyToken(invoiceId, token) {
  return token === payToken(invoiceId);
}

// PayFast requires an MD5 of all params concatenated as URL-encoded key=value pairs.
function buildSignature(params, passphrase) {
  const str = Object.entries(params)
    .filter(([k]) => k !== 'signature')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v ?? '').trim())}`)
    .join('&');
  const withPass = passphrase
    ? `${str}&passphrase=${encodeURIComponent(passphrase.trim())}`
    : str;
  return crypto.createHash('md5').update(withPass).digest('hex');
}

async function buildPaymentParams(invoice, senderName, accountId) {
  const creds = await getCredentials(accountId);
  const nameParts = (invoice.contact_name || 'Customer').split(' ');
  const params = {
    merchant_id:   creds.merchantId,
    merchant_key:  creds.merchantKey,
    return_url:    `${appUrl()}/pay/success`,
    cancel_url:    `${appUrl()}/pay/cancel`,
    notify_url:    `${appUrl()}/payfast/notify`,
    name_first:    nameParts[0] || 'Customer',
    name_last:     nameParts.slice(1).join(' ') || '',
    email_address: invoice.contact_email || '',
    m_payment_id:  invoice.id,
    amount:        Number(invoice.amount_due).toFixed(2),
    item_name:     `Invoice ${invoice.invoice_number || invoice.id} — ${senderName}`.slice(0, 100),
  };
  params.signature = buildSignature(params, creds.passphrase);
  return params;
}

// The short pay link we embed in messages
function getPayUrl(invoiceId) {
  return `${appUrl()}/pay/${payToken(invoiceId)}/${invoiceId}`;
}

// Returns true if PayFast's notify POST is legitimate
async function validateNotify(body, accountId) {
  const { signature, ...rest } = body;
  if (!signature) return false;
  const creds = await getCredentials(accountId);
  const expected = buildSignature(rest, creds.passphrase);
  return signature === expected;
}

async function isConfigured(accountId) {
  const creds = await getCredentials(accountId);
  return !!(creds.merchantId && creds.merchantKey);
}

module.exports = { payToken, verifyToken, buildPaymentParams, getPayUrl, PAYFAST_URL, validateNotify, isConfigured };
