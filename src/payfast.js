/**
 * PayFast payment link generation + webhook validation.
 * Generates a /pay/:token/:invoiceId URL included in every chase message.
 * When the client pays, PayFast POSTs to /payfast/notify — we mark the invoice paid.
 */

const crypto = require('crypto');

const PAYFAST_URL = process.env.PAYFAST_SANDBOX === 'true'
  ? 'https://sandbox.payfast.co.za/eng/process'
  : 'https://www.payfast.co.za/eng/process';

const merchantId  = () => process.env.PAYFAST_MERCHANT_ID;
const merchantKey = () => process.env.PAYFAST_MERCHANT_KEY;
const passphrase  = () => process.env.PAYFAST_PASSPHRASE || '';
const appUrl      = () => process.env.APP_URL || 'https://paid-up.co.za';
const tokenSecret = () => process.env.PAY_TOKEN_SECRET || process.env.SESSION_SECRET || 'paidup-pay-secret';

// Derive a short HMAC token from the invoice ID — no DB column needed.
function payToken(invoiceId) {
  return crypto.createHmac('sha256', tokenSecret()).update(String(invoiceId)).digest('hex').slice(0, 32);
}

function verifyToken(invoiceId, token) {
  return token === payToken(invoiceId);
}

// PayFast requires an MD5 of all params concatenated as URL-encoded key=value pairs.
function buildSignature(params) {
  const str = Object.entries(params)
    .filter(([k]) => k !== 'signature')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v ?? '').trim())}`)
    .join('&');
  const withPass = passphrase()
    ? `${str}&passphrase=${encodeURIComponent(passphrase().trim())}`
    : str;
  return crypto.createHash('md5').update(withPass).digest('hex');
}

function buildPaymentParams(invoice, senderName) {
  const nameParts = (invoice.contact_name || 'Customer').split(' ');
  const params = {
    merchant_id:   merchantId(),
    merchant_key:  merchantKey(),
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
  params.signature = buildSignature(params);
  return params;
}

// The short pay link we embed in messages
function getPayUrl(invoiceId) {
  return `${appUrl()}/pay/${payToken(invoiceId)}/${invoiceId}`;
}

// Returns true if PayFast's notify POST is legitimate
function validateNotify(body) {
  const { signature, ...rest } = body;
  if (!signature) return false;
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(buildSignature(rest))
  );
}

function isConfigured() {
  return !!(merchantId() && merchantKey());
}

module.exports = { payToken, verifyToken, buildPaymentParams, getPayUrl, PAYFAST_URL, validateNotify, isConfigured };
