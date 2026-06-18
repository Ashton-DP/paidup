const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Stage definitions — determines tone and urgency
const STAGES = {
  1: { label: 'friendly reminder', daysOverdue: 1  },
  2: { label: 'firm follow-up',   daysOverdue: 7  },
  3: { label: 'final notice',     daysOverdue: 21 },
};

function formatZAR(amount) {
  return `R${Number(amount).toLocaleString('en-ZA', { minimumFractionDigits: 2 })}`;
}

async function generateChaseMessage({ invoice, stage, channel, senderName }) {
  const stageInfo = STAGES[stage];
  const amountStr = formatZAR(invoice.amount_due);
  const isWhatsApp = channel === 'whatsapp';

  const system = `You are an accounts receivable assistant for a South African business called "${senderName}".
Your job is to write invoice payment reminders that are professional, polite, and effective.
You understand South African business culture: direct but respectful, not aggressive.
Always write in clear South African English. Never use American spellings.
Keep messages concise — clients read these on their phones.`;

  const prompt = `Write a ${stageInfo.label} payment reminder for the following overdue invoice.

Invoice details:
- Client: ${invoice.contact_name}
- Invoice number: ${invoice.invoice_number}
- Amount due: ${amountStr}
- Days overdue: ${invoice.days_overdue}
- Due date: ${invoice.due_date}

Channel: ${isWhatsApp ? 'WhatsApp message (conversational, brief, no formal letter format)' : 'Email (professional but friendly)'}
Stage: ${stage} of 3

Stage guidance:
${stage === 1 ? '- Friendly, assume it was an oversight. No pressure. Just a polite nudge.' : ''}
${stage === 2 ? '- Firm but still professional. Reference that this is a follow-up. Ask for a specific payment date or confirmation.' : ''}
${stage === 3 ? '- Serious tone. Final notice. Mention that failure to pay may result in referral to a collections agency. Still professional — not threatening.' : ''}

${isWhatsApp
  ? 'Format: plain text only, no markdown, no subject line, 3-5 sentences max. Start with "Hi [Name],"'
  : 'Format: include Subject: line first, then blank line, then the email body. Sign off with the sender name.'}

Output only the message text — no explanation, no notes.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
    system,
  });

  return response.content[0].text.trim();
}

// Determine which stage an invoice should be chased at, based on days overdue
// and what stage was last sent (never skip a stage, never repeat within 6 days).
function nextChaseStage(invoice) {
  const { days_overdue, chase_stage, last_chased_at, snoozed_until } = invoice;

  if (snoozed_until && new Date(snoozed_until) > new Date()) return null;

  const daysSinceLastChase = last_chased_at
    ? Math.floor((Date.now() - new Date(last_chased_at)) / 86400000)
    : 999;

  // Don't re-chase within 6 days of last message
  if (daysSinceLastChase < 6) return null;

  if (chase_stage === 0 && days_overdue >= 1)  return 1;
  if (chase_stage === 1 && days_overdue >= 7)  return 2;
  if (chase_stage === 2 && days_overdue >= 21) return 3;

  return null;
}

module.exports = { generateChaseMessage, nextChaseStage, STAGES };
