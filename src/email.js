const nodemailer = require('nodemailer');

// Gmail SMTP transport (App Password auth). Created lazily so a missing
// credential only errors when we actually try to send, not on require.
let _transport = null;
function transport() {
  if (_transport) return _transport;
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error('GMAIL_USER / GMAIL_APP_PASSWORD not set in .env');
  }
  _transport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass },
  });
  return _transport;
}

// Resend (https://resend.com) — preferred for production: send from your own
// authenticated domain (SPF/DKIM) so reminders land in inboxes, not spam.
async function sendViaResend({ from, to, toName, subject, text, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [toName ? `${toName} <${to}>` : to],
      subject, text, html,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('[email] Resend error:', res.status, JSON.stringify(data));
    throw new Error(data?.message || `Resend error ${res.status}`);
  }
  return data;
}

// Split the AI-generated message into subject + body (email has "Subject: ..." line)
function parseEmailMessage(raw) {
  const lines = raw.split('\n');
  const subjectLine = lines.find(l => l.toLowerCase().startsWith('subject:'));
  const subject = subjectLine
    ? subjectLine.replace(/^subject:\s*/i, '').trim()
    : 'Invoice payment reminder';
  const body = lines
    .filter(l => !l.toLowerCase().startsWith('subject:'))
    .join('\n').trim();
  return { subject, body };
}

async function sendChaseEmail({ to, toName, rawMessage, invoiceNumber, senderName, paymentUrl }) {
  const { subject, body } = parseEmailMessage(rawMessage);

  const htmlBody = body
    .split('\n\n')
    .map(p => `<p style="margin:0 0 14px;line-height:1.6;">${p.replace(/\n/g, '<br>')}</p>`)
    .join('');

  const payButton = paymentUrl ? `
        <tr>
          <td style="padding:0 32px 28px;text-align:center;">
            <a href="${paymentUrl}"
               style="display:inline-block;background:#1a9e5f;color:#fff;font-size:15px;font-weight:700;padding:14px 32px;border-radius:8px;text-decoration:none;letter-spacing:.01em;">
              Pay Now →
            </a>
            <p style="margin:10px 0 0;color:#aaa;font-size:11px;">Secure payment powered by PayFast</p>
          </td>
        </tr>` : '';

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:32px 16px;">
      <table width="560" cellpadding="0" cellspacing="0"
             style="background:#fff;border-radius:8px;overflow:hidden;border:1px solid #e0e0e0;">
        <tr>
          <td style="background:#1a1a2e;padding:20px 32px;">
            <p style="margin:0;color:#fff;font-size:16px;font-weight:bold;">${senderName}</p>
            <p style="margin:4px 0 0;color:#aaa;font-size:12px;">Invoice ${invoiceNumber}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;">
            <div style="color:#333;font-size:15px;">${htmlBody}</div>
          </td>
        </tr>
        ${payButton}
        <tr>
          <td style="padding:0 32px 24px;border-top:1px solid #f0f0f0;">
            <p style="margin:16px 0 0;color:#999;font-size:11px;">
              This is an automated payment reminder. If you have already settled this invoice,
              please disregard. To unsubscribe from reminders, reply "STOP".
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const fromName = senderName || process.env.FROM_NAME || 'PaidUp';

  if (process.env.RESEND_API_KEY) {
    // Production path: send from the authenticated domain via Resend.
    await sendViaResend({
      from: `${fromName} <${process.env.FROM_EMAIL}>`,
      to, toName, subject, text: body, html,
    });
    console.log(`[email] (resend) sent to ${to} re invoice ${invoiceNumber}`);
    return;
  }

  // Fallback: Gmail SMTP (dev / before the domain is verified in Resend).
  await transport().sendMail({
    from: `"${fromName}" <${process.env.GMAIL_USER}>`,
    to: toName ? `"${toName}" <${to}>` : to,
    subject,
    text: body,
    html,
  });
  console.log(`[email] (gmail) sent to ${to} re invoice ${invoiceNumber}`);
}

async function sendPaymentNotification({ to, toName, contactName, invoiceNumber, amount, currency }) {
  const fmt = n => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: currency || 'ZAR' }).format(Number(n));
  const html = `
<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0">
  <tr><td align="center" style="padding:32px 16px;">
    <table width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;border:1px solid #e0e0e0;">
      <tr><td style="background:#1a9e5f;padding:20px 28px;text-align:center;">
        <p style="margin:0;font-size:28px;">💰</p>
        <p style="margin:8px 0 0;color:#fff;font-size:18px;font-weight:700;">Payment received!</p>
      </td></tr>
      <tr><td style="padding:28px;text-align:center;">
        <p style="font-size:32px;font-weight:700;color:#1a1a2e;margin:0">${fmt(amount)}</p>
        <p style="color:#666;margin:8px 0 20px">${contactName} · Invoice ${invoiceNumber}</p>
        <p style="color:#888;font-size:13px">PaidUp has marked this invoice as paid.</p>
      </td></tr>
    </table>
  </td></tr>
</table></body></html>`;

  const fromName = toName || 'PaidUp';
  if (process.env.RESEND_API_KEY) {
    await sendViaResend({ from: `PaidUp <${process.env.FROM_EMAIL}>`, to, toName, subject: `💰 Payment received — ${contactName} paid ${fmt(amount)}`, text: `${contactName} paid ${fmt(amount)} for invoice ${invoiceNumber}.`, html });
  } else {
    await transport().sendMail({ from: `"PaidUp" <${process.env.GMAIL_USER}>`, to, subject: `Payment received — ${contactName} paid ${fmt(amount)}`, html });
  }
}

async function sendDigestEmail({ to, toName, stats }) {
  if (!stats.chased && !stats.paid_count && !stats.outstanding) return; // nothing to report
  const fmt = n => `R${Number(n).toLocaleString('en-ZA', { minimumFractionDigits: 2 })}`;
  const rows = [
    stats.chased       ? `<tr><td style="padding:8px 0;color:#888;border-bottom:1px solid #f0f0f0">Reminders sent</td><td style="padding:8px 0;text-align:right;font-weight:600;color:#ddd;border-bottom:1px solid #f0f0f0">${stats.chased}</td></tr>` : '',
    stats.paid_count   ? `<tr><td style="padding:8px 0;color:#888;border-bottom:1px solid #f0f0f0">Invoices paid</td><td style="padding:8px 0;text-align:right;font-weight:700;color:#4ade80;border-bottom:1px solid #f0f0f0">${stats.paid_count} (${fmt(stats.paid_amount)})</td></tr>` : '',
    stats.outstanding  ? `<tr><td style="padding:8px 0;color:#888">Still outstanding</td><td style="padding:8px 0;text-align:right;font-weight:600;color:#ff6b6b">${fmt(stats.outstanding)}</td></tr>` : '',
  ].join('');

  const html = `
<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0">
  <tr><td align="center" style="padding:32px 16px;">
    <table width="480" cellpadding="0" cellspacing="0" style="background:#1a1a2e;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:20px 28px;border-bottom:1px solid #2a2a3e">
        <p style="margin:0;color:#fff;font-size:16px;font-weight:700;">PaidUp</p>
        <p style="margin:4px 0 0;color:#888;font-size:12px;">Daily digest — last 24 hours</p>
      </td></tr>
      <tr><td style="padding:24px 28px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="color:#e8e8ec;font-size:14px">${rows}</table>
        <p style="margin:20px 0 0;text-align:center"><a href="https://paid-up.co.za/app" style="background:#6c8fff;color:#fff;padding:10px 24px;border-radius:7px;text-decoration:none;font-size:13px;font-weight:600">Open dashboard →</a></p>
      </td></tr>
    </table>
  </td></tr>
</table></body></html>`;

  const subject = stats.paid_count
    ? `💰 ${stats.paid_count} invoice${stats.paid_count > 1 ? 's' : ''} paid today — PaidUp digest`
    : `📋 PaidUp daily digest — ${stats.chased} reminder${stats.chased !== 1 ? 's' : ''} sent`;

  if (process.env.RESEND_API_KEY) {
    await sendViaResend({ from: `PaidUp <${process.env.FROM_EMAIL}>`, to, toName, subject, text: subject, html });
  } else {
    await transport().sendMail({ from: `"PaidUp" <${process.env.GMAIL_USER}>`, to, subject, html });
  }
}

module.exports = { sendChaseEmail, parseEmailMessage, sendPaymentNotification, sendDigestEmail };
