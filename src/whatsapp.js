const twilio = require('twilio');

// Lazily create the Twilio client so a missing/placeholder credential only
// errors when we actually try to send, not on require (which would crash boot).
let _client = null;
function client() {
  if (_client) return _client;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token || sid.startsWith('ACplaceholder')) {
    throw new Error('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set in .env');
  }
  _client = twilio(sid, token);
  return _client;
}

// Normalise a South African number to E.164 WhatsApp format
function formatZANumber(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('27') && digits.length === 11) return `whatsapp:+${digits}`;
  if (digits.startsWith('0') && digits.length === 10)  return `whatsapp:+27${digits.slice(1)}`;
  if (digits.length === 9)                              return `whatsapp:+27${digits}`;
  return null;
}

async function sendWhatsApp({ to, message, invoiceNumber }) {
  const toFormatted = formatZANumber(to);
  if (!toFormatted) {
    console.warn(`[whatsapp] skipped ${invoiceNumber} — invalid number: ${to}`);
    return false;
  }

  await client().messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM,
    to: toFormatted,
    body: message,
  });

  console.log(`[whatsapp] sent to ${toFormatted} re invoice ${invoiceNumber}`);
  return true;
}

// Handle inbound WhatsApp reply from Twilio webhook
// Returns parsed intent: 'snooze', 'paid', 'dispute', 'unknown'
function parseReplyIntent(body = '') {
  const text = body.toLowerCase().trim();
  if (/\b(friday|monday|tuesday|wednesday|thursday|week|tomorrow|\d+\s*days?)\b/.test(text)) {
    return 'snooze';
  }
  if (/\b(paid|payment|done|settled|transferred|eft)\b/.test(text)) return 'paid';
  if (/\b(dispute|incorrect|wrong|issue|query|problem)\b/.test(text))  return 'dispute';
  if (/\bstop\b/.test(text)) return 'stop';
  return 'unknown';
}

module.exports = { sendWhatsApp, parseReplyIntent, formatZANumber };
