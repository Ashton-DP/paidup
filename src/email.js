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

async function sendChaseEmail({ to, toName, rawMessage, invoiceNumber, senderName }) {
  const { subject, body } = parseEmailMessage(rawMessage);

  const htmlBody = body
    .split('\n\n')
    .map(p => `<p style="margin:0 0 14px;line-height:1.6;">${p.replace(/\n/g, '<br>')}</p>`)
    .join('');

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

  const fromName = process.env.FROM_NAME || senderName;
  await transport().sendMail({
    // Gmail SMTP sends as the authenticated account; display name can vary.
    from: `"${fromName}" <${process.env.GMAIL_USER}>`,
    to: toName ? `"${toName}" <${to}>` : to,
    subject,
    text: body,
    html,
  });

  console.log(`[email] sent stage message to ${to} re invoice ${invoiceNumber}`);
}

module.exports = { sendChaseEmail, parseEmailMessage };
