/**
 * Chase engine — the core loop.
 *
 * Called by the daily cron job and on-demand from the dashboard.
 * For every overdue invoice that hasn't been paid or snoozed, it:
 *   1. Determines if a new chase message is due (nextChaseStage)
 *   2. Generates personalised AI message for email + WhatsApp separately
 *   3. Sends via both channels where contact details exist
 *   4. Logs every send to chase_log and advances invoice.chase_stage
 */

const db = require('./db');
const { generateChaseMessage, nextChaseStage, parseReplyWithAI } = require('./ai');
const { sendChaseEmail } = require('./email');
const { sendWhatsApp } = require('./whatsapp');
const { phoneKey, emailKey, isSuppressed, isChasingPaused, addSuppression } = require('./safety');
const { getCadence, getAppSettings } = require('./settings');
const payfast = require('./payfast');

async function runChaseForTenant(tenantRow, { checkTime = false } = {}) {
  const accountId = tenantRow.account_id;
  // Per-account kill switch — halt all outbound chasing for this account.
  if (await isChasingPaused(accountId)) {
    console.log('[chaser] chasing is paused — skipping run');
    return 0;
  }

  // Respect per-account send time preferences when running from the cron.
  if (checkTime) {
    const s = await getAppSettings(accountId);
    const now = new Date();
    const hour = now.getUTCHours();
    const day  = now.getUTCDay();
    const allowedDays = String(s.send_days || '1,2,3,4,5').split(',').map(Number);
    const sendHour = Number(s.send_hour ?? 8);
    if (hour !== sendHour || !allowedDays.includes(day)) {
      return 0;
    }
  }

  // Skip disputed invoices (a 'dispute' reply pauses them for human review).
  const invoices = await db.all(`
    SELECT * FROM invoices
    WHERE tenant_id = ? AND status = 'OVERDUE' AND COALESCE(disputed, 0) = 0
    ORDER BY days_overdue DESC
  `, tenantRow.id);

  const cadence = await getCadence(accountId);
  const businessName = (await getAppSettings(accountId)).business_name;
  let chased = 0;

  for (const invoice of invoices) {
    const stage = nextChaseStage(invoice, cadence);
    if (!stage) continue;

    const senderName = businessName || tenantRow.name;

    try {
      const paymentUrl = await payfast.isConfigured(accountId) ? payfast.getPayUrl(invoice.id) : null;

      // ── Email ──────────────────────────────────────────────────────────
      if (invoice.contact_email &&
          !await isSuppressed(tenantRow.id, 'email', emailKey(invoice.contact_email))) {
        const emailMsg = await generateChaseMessage({
          invoice, stage, channel: 'email', senderName, paymentUrl,
        });
        await sendChaseEmail({
          to: invoice.contact_email,
          toName: invoice.contact_name,
          rawMessage: emailMsg,
          invoiceNumber: invoice.invoice_number,
          senderName,
          paymentUrl,
        });
        await logSend({ invoice, stage, channel: 'email',
                        recipient: invoice.contact_email, body: emailMsg });
      }

      // ── WhatsApp ───────────────────────────────────────────────────────
      if (invoice.contact_phone &&
          !await isSuppressed(tenantRow.id, 'whatsapp', phoneKey(invoice.contact_phone))) {
        const waMsg = await generateChaseMessage({
          invoice, stage, channel: 'whatsapp', senderName, paymentUrl,
        });
        const fullMsg = paymentUrl ? `${waMsg}\n\nPay now: ${paymentUrl}` : waMsg;
        const sent = await sendWhatsApp({
          to: invoice.contact_phone,
          message: fullMsg,
          invoiceNumber: invoice.invoice_number,
        });
        if (sent) {
          await logSend({ invoice, stage, channel: 'whatsapp',
                          recipient: invoice.contact_phone, body: fullMsg });
        }
      }

      // ── Advance invoice state ──────────────────────────────────────────
      await db.run(
        `UPDATE invoices SET chase_stage = ?, last_chased_at = NOW(), updated_at = NOW() WHERE id = ?`,
        stage, invoice.id
      );

      chased++;
    } catch (err) {
      console.error(`[chaser] failed invoice ${invoice.invoice_number}:`, err.message);
    }
  }

  // Flag invoices ready for debt collection: stage 3 sent + still unpaid + 45+ days overdue
  await db.run(`
    UPDATE invoices SET debt_collect_flagged = TRUE, updated_at = NOW()
    WHERE tenant_id = ? AND status = 'OVERDUE' AND chase_stage >= 3
      AND days_overdue >= 45 AND COALESCE(debt_collect_flagged, FALSE) = FALSE
  `, tenantRow.id);

  console.log(`[chaser] ${chased}/${invoices.length} invoices chased for ${tenantRow.name}`);
  return chased;
}

async function logSend({ invoice, stage, channel, recipient, body }) {
  await db.run(
    `INSERT INTO chase_log (invoice_id, tenant_id, stage, channel, recipient, message_body)
     VALUES (?, ?, ?, ?, ?, ?)`,
    invoice.id, invoice.tenant_id, stage, channel, recipient, body
  );
}

async function runChaseAll({ checkTime = false } = {}) {
  const tenants = await db.all(`SELECT * FROM tenants WHERE tokens IS NOT NULL`);
  for (const tenant of tenants) {
    await runChaseForTenant(tenant, { checkTime });
  }
}

// Handle a WhatsApp reply: opt-out, snooze, mark paid, or flag dispute.
// Uses AI to understand nuanced replies ("I'll pay on the 25th", "Can we split it?").
async function handleReply({ tenantId, fromNumber, body, intent: rawIntent }) {
  await db.run(
    `INSERT INTO replies (tenant_id, from_number, body, channel) VALUES (?, ?, ?, 'whatsapp')`,
    tenantId, fromNumber, body
  );

  const key = phoneKey(fromNumber);
  const match = key ? `%${key}%` : null;

  // Use AI parsing for richer intent; fall back to the regex-based intent passed in.
  let intent = rawIntent || 'unknown';
  let snoozeDate = null;
  try {
    const parsed = await parseReplyWithAI(body);
    if (parsed.intent && parsed.intent !== 'unknown') {
      intent = parsed.intent;
      snoozeDate = parsed.date || null;
    }
  } catch { /* keep rawIntent */ }

  if (intent === 'stop') {
    await addSuppression(tenantId, 'whatsapp', key, 'stop');
    if (match) {
      await db.run(
        `UPDATE invoices SET disputed = 1, updated_at = NOW() WHERE tenant_id = ? AND contact_phone LIKE ?`,
        tenantId, match
      );
    }
  }

  if (intent === 'paid' && match) {
    await db.run(
      `UPDATE invoices SET status = 'PAID', paid_at = NOW(), updated_at = NOW()
       WHERE tenant_id = ? AND contact_phone LIKE ?`,
      tenantId, match
    );
  }

  if (intent === 'snooze' && match) {
    // If AI extracted a specific date, snooze until then; otherwise 5 days.
    const until = snoozeDate
      ? `'${snoozeDate}'::date`
      : `NOW() + INTERVAL '5 days'`;
    await db.run(
      `UPDATE invoices SET snoozed_until = ${until}, updated_at = NOW()
       WHERE tenant_id = ? AND contact_phone LIKE ?`,
      tenantId, match
    );
  }

  if (intent === 'dispute' && match) {
    await db.run(
      `UPDATE invoices SET disputed = 1, updated_at = NOW() WHERE tenant_id = ? AND contact_phone LIKE ?`,
      tenantId, match
    );
  }
}

// ── Single-invoice manual chasing (operator-driven, with preview) ────────────

// The stage a manual chase should use: the natural next stage if due, else the
// next stage up (capped at final) so the operator can always escalate by hand.
async function computeManualStage(invoice, accountId) {
  return nextChaseStage(invoice, await getCadence(accountId)) || Math.min((invoice.chase_stage || 0) + 1, 3) || 1;
}

async function loadInvoiceWithSender(invoiceId) {
  const invoice = await db.get(`SELECT * FROM invoices WHERE id = ?`, invoiceId);
  if (!invoice) throw new Error('Invoice not found');
  const tenant = await db.get(`SELECT * FROM tenants WHERE id = ?`, invoice.tenant_id);
  const accountId = tenant?.account_id;
  const senderName = (await getAppSettings(accountId)).business_name || tenant?.name || 'PaidUp';
  return { invoice, senderName, accountId };
}

// Generate (but DO NOT send) the messages for one invoice, so the operator can
// review before sending.
async function previewChase(invoiceId) {
  const { invoice, senderName, accountId } = await loadInvoiceWithSender(invoiceId);
  const stage = await computeManualStage(invoice, accountId);
  const paymentUrl = await payfast.isConfigured(accountId) ? payfast.getPayUrl(invoice.id) : null;
  const out = { stage, contact_name: invoice.contact_name, paymentUrl };
  if (invoice.contact_email) {
    out.email = await generateChaseMessage({ invoice, stage, channel: 'email', senderName, paymentUrl });
    out.email_suppressed = await isSuppressed(invoice.tenant_id, 'email', emailKey(invoice.contact_email));
  }
  if (invoice.contact_phone) {
    out.whatsapp = await generateChaseMessage({ invoice, stage, channel: 'whatsapp', senderName, paymentUrl });
    if (paymentUrl) out.whatsapp += `\n\nPay now: ${paymentUrl}`;
    out.whatsapp_suppressed = await isSuppressed(invoice.tenant_id, 'whatsapp', phoneKey(invoice.contact_phone));
  }
  return out;
}

// Send the chase for ONE invoice (operator override — ignores the global pause,
// but still never messages an opted-out channel). Advances the stage.
async function sendChaseForInvoice(invoiceId) {
  const { invoice, senderName, accountId } = await loadInvoiceWithSender(invoiceId);
  const stage = await computeManualStage(invoice, accountId);
  const sent = [];
  const errors = [];

  const paymentUrl = await payfast.isConfigured(accountId) ? payfast.getPayUrl(invoice.id) : null;

  if (invoice.contact_email && !await isSuppressed(invoice.tenant_id, 'email', emailKey(invoice.contact_email))) {
    try {
      const msg = await generateChaseMessage({ invoice, stage, channel: 'email', senderName, paymentUrl });
      await sendChaseEmail({ to: invoice.contact_email, toName: invoice.contact_name,
                             rawMessage: msg, invoiceNumber: invoice.invoice_number, senderName, paymentUrl });
      await logSend({ invoice, stage, channel: 'email', recipient: invoice.contact_email, body: msg });
      sent.push('email');
    } catch (e) { errors.push('email: ' + (e.message || e)); }
  }

  if (invoice.contact_phone && !await isSuppressed(invoice.tenant_id, 'whatsapp', phoneKey(invoice.contact_phone))) {
    try {
      const msg = await generateChaseMessage({ invoice, stage, channel: 'whatsapp', senderName, paymentUrl });
      const fullMsg = paymentUrl ? `${msg}\n\nPay now: ${paymentUrl}` : msg;
      const ok = await sendWhatsApp({ to: invoice.contact_phone, message: fullMsg, invoiceNumber: invoice.invoice_number });
      if (ok) {
        await logSend({ invoice, stage, channel: 'whatsapp', recipient: invoice.contact_phone, body: fullMsg });
        sent.push('whatsapp');
      }
    } catch (e) { errors.push('whatsapp: ' + (e.message || e)); }
  }

  if (sent.length) {
    await db.run(
      `UPDATE invoices SET chase_stage = ?, last_chased_at = NOW(), updated_at = NOW() WHERE id = ?`,
      stage, invoiceId
    );
  }
  return { stage, sent, errors };
}

module.exports = {
  runChaseForTenant, runChaseAll, handleReply,
  previewChase, sendChaseForInvoice,
};
