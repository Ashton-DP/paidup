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
const { generateChaseMessage, nextChaseStage } = require('./ai');
const { sendChaseEmail } = require('./email');
const { sendWhatsApp } = require('./whatsapp');
const { phoneKey, emailKey, isSuppressed, isChasingPaused, addSuppression } = require('./safety');

async function runChaseForTenant(tenantRow) {
  // Global kill switch — halt all outbound chasing.
  if (isChasingPaused()) {
    console.log('[chaser] chasing is paused — skipping run');
    return 0;
  }

  // Skip disputed invoices (a 'dispute' reply pauses them for human review).
  const invoices = db.prepare(`
    SELECT * FROM invoices
    WHERE tenant_id = ? AND status = 'OVERDUE' AND COALESCE(disputed, 0) = 0
    ORDER BY days_overdue DESC
  `).all(tenantRow.id);

  let chased = 0;

  for (const invoice of invoices) {
    const stage = nextChaseStage(invoice);
    if (!stage) continue;

    const senderName = tenantRow.name;

    try {
      // ── Email ──────────────────────────────────────────────────────────
      if (invoice.contact_email &&
          !isSuppressed(tenantRow.id, 'email', emailKey(invoice.contact_email))) {
        const emailMsg = await generateChaseMessage({
          invoice, stage, channel: 'email', senderName,
        });
        await sendChaseEmail({
          to: invoice.contact_email,
          toName: invoice.contact_name,
          rawMessage: emailMsg,
          invoiceNumber: invoice.invoice_number,
          senderName,
        });
        logSend({ invoice, stage, channel: 'email',
                  recipient: invoice.contact_email, body: emailMsg });
      }

      // ── WhatsApp ───────────────────────────────────────────────────────
      if (invoice.contact_phone &&
          !isSuppressed(tenantRow.id, 'whatsapp', phoneKey(invoice.contact_phone))) {
        const waMsg = await generateChaseMessage({
          invoice, stage, channel: 'whatsapp', senderName,
        });
        const sent = await sendWhatsApp({
          to: invoice.contact_phone,
          message: waMsg,
          invoiceNumber: invoice.invoice_number,
        });
        if (sent) {
          logSend({ invoice, stage, channel: 'whatsapp',
                    recipient: invoice.contact_phone, body: waMsg });
        }
      }

      // ── Advance invoice state ──────────────────────────────────────────
      db.prepare(`UPDATE invoices
                  SET chase_stage = ?, last_chased_at = datetime('now'),
                      updated_at  = datetime('now')
                  WHERE id = ?`).run(stage, invoice.id);

      chased++;
    } catch (err) {
      console.error(`[chaser] failed invoice ${invoice.invoice_number}:`, err.message);
    }
  }

  console.log(`[chaser] ${chased}/${invoices.length} invoices chased for ${tenantRow.name}`);
  return chased;
}

function logSend({ invoice, stage, channel, recipient, body }) {
  db.prepare(`INSERT INTO chase_log
    (invoice_id, tenant_id, stage, channel, recipient, message_body)
    VALUES (?, ?, ?, ?, ?, ?)`
  ).run(invoice.id, invoice.tenant_id, stage, channel, recipient, body);
}

async function runChaseAll() {
  const tenants = db.prepare(`SELECT * FROM tenants WHERE tokens IS NOT NULL`).all();
  for (const tenant of tenants) {
    await runChaseForTenant(tenant);
  }
}

// Handle a WhatsApp reply: opt-out, snooze, mark paid, or flag dispute
function handleReply({ tenantId, fromNumber, body, intent }) {
  db.prepare(`INSERT INTO replies (tenant_id, from_number, body, channel)
              VALUES (?, ?, ?, 'whatsapp')`).run(tenantId, fromNumber, body);

  const key = phoneKey(fromNumber);
  const match = key ? `%${key}%` : null;

  if (intent === 'stop') {
    // Opt-out: never message this number again, and pause its invoices.
    addSuppression(tenantId, 'whatsapp', key, 'stop');
    if (match) db.prepare(`UPDATE invoices SET disputed = 1, updated_at = datetime('now')
                           WHERE tenant_id = ? AND contact_phone LIKE ?`).run(tenantId, match);
  }

  if (intent === 'paid' && match) {
    db.prepare(`UPDATE invoices SET status = 'PAID', paid_at = datetime('now')
                WHERE tenant_id = ? AND contact_phone LIKE ?`).run(tenantId, match);
  }

  if (intent === 'snooze' && match) {
    // snooze for 5 days — give client the benefit of the doubt
    db.prepare(`UPDATE invoices
                SET snoozed_until = datetime('now', '+5 days'),
                    updated_at    = datetime('now')
                WHERE tenant_id = ? AND contact_phone LIKE ?`).run(tenantId, match);
  }

  if (intent === 'dispute' && match) {
    // Pause chasing on the invoice(s) until a human resolves the dispute.
    db.prepare(`UPDATE invoices SET disputed = 1, updated_at = datetime('now')
                WHERE tenant_id = ? AND contact_phone LIKE ?`).run(tenantId, match);
  }
}

// ── Single-invoice manual chasing (operator-driven, with preview) ────────────

// The stage a manual chase should use: the natural next stage if due, else the
// next stage up (capped at final) so the operator can always escalate by hand.
function computeManualStage(invoice) {
  return nextChaseStage(invoice) || Math.min((invoice.chase_stage || 0) + 1, 3) || 1;
}

function loadInvoiceWithSender(invoiceId) {
  const invoice = db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(invoiceId);
  if (!invoice) throw new Error('Invoice not found');
  const tenant = db.prepare(`SELECT * FROM tenants WHERE id = ?`).get(invoice.tenant_id);
  return { invoice, senderName: tenant?.name || 'PaidUp' };
}

// Generate (but DO NOT send) the messages for one invoice, so the operator can
// review before sending.
async function previewChase(invoiceId) {
  const { invoice, senderName } = loadInvoiceWithSender(invoiceId);
  const stage = computeManualStage(invoice);
  const out = { stage, contact_name: invoice.contact_name };
  if (invoice.contact_email) {
    out.email = await generateChaseMessage({ invoice, stage, channel: 'email', senderName });
    out.email_suppressed = isSuppressed(invoice.tenant_id, 'email', emailKey(invoice.contact_email));
  }
  if (invoice.contact_phone) {
    out.whatsapp = await generateChaseMessage({ invoice, stage, channel: 'whatsapp', senderName });
    out.whatsapp_suppressed = isSuppressed(invoice.tenant_id, 'whatsapp', phoneKey(invoice.contact_phone));
  }
  return out;
}

// Send the chase for ONE invoice (operator override — ignores the global pause,
// but still never messages an opted-out channel). Advances the stage.
async function sendChaseForInvoice(invoiceId) {
  const { invoice, senderName } = loadInvoiceWithSender(invoiceId);
  const stage = computeManualStage(invoice);
  const sent = [];

  const errors = [];

  if (invoice.contact_email && !isSuppressed(invoice.tenant_id, 'email', emailKey(invoice.contact_email))) {
    try {
      const msg = await generateChaseMessage({ invoice, stage, channel: 'email', senderName });
      await sendChaseEmail({ to: invoice.contact_email, toName: invoice.contact_name,
                             rawMessage: msg, invoiceNumber: invoice.invoice_number, senderName });
      logSend({ invoice, stage, channel: 'email', recipient: invoice.contact_email, body: msg });
      sent.push('email');
    } catch (e) { errors.push('email: ' + (e.message || e)); }
  }

  if (invoice.contact_phone && !isSuppressed(invoice.tenant_id, 'whatsapp', phoneKey(invoice.contact_phone))) {
    try {
      const msg = await generateChaseMessage({ invoice, stage, channel: 'whatsapp', senderName });
      const ok = await sendWhatsApp({ to: invoice.contact_phone, message: msg, invoiceNumber: invoice.invoice_number });
      if (ok) { logSend({ invoice, stage, channel: 'whatsapp', recipient: invoice.contact_phone, body: msg }); sent.push('whatsapp'); }
    } catch (e) { errors.push('whatsapp: ' + (e.message || e)); }
  }

  if (sent.length) {
    db.prepare(`UPDATE invoices SET chase_stage = ?, last_chased_at = datetime('now'),
                updated_at = datetime('now') WHERE id = ?`).run(stage, invoiceId);
  }
  return { stage, sent, errors };
}

module.exports = {
  runChaseForTenant, runChaseAll, handleReply,
  previewChase, sendChaseForInvoice,
};
