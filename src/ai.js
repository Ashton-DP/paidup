// PaidUp uses Google's Gemini API (free tier) for chase-message generation.
// Called over plain REST with Node's global fetch — no SDK dependency.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
// Fallback chain: if the primary model is overloaded (503) or retired (404),
// rotate to the next. `gemini-flash-latest` always points at a current model.
const GEMINI_FALLBACKS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest'];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callGemini({ system, prompt, maxTokens = 600 }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set in .env');

  const models = [GEMINI_MODEL, ...GEMINI_FALLBACKS.filter(m => m !== GEMINI_MODEL)];
  const MAX_ROUNDS = 3; // the free tier spikes — retry the whole rotation
  let lastErr;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    for (const model of models) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: system }] },
              contents: [{ role: 'user', parts: [{ text: prompt }] }],
              generationConfig: {
                maxOutputTokens: maxTokens,
                temperature: 0.7,
                // Disable "thinking" — these are short messages; thinking would
                // burn the output budget and can return empty text.
                thinkingConfig: { thinkingBudget: 0 },
              },
            }),
          }
        );

        if (!res.ok) {
          const body = await res.text();
          // 503 overloaded / 404 retired → try next model; anything else is fatal.
          if (res.status === 503 || res.status === 404 || res.status === 429) {
            lastErr = new Error(`Gemini ${model} ${res.status}: ${body.slice(0, 200)}`);
            continue;
          }
          throw new Error(`Gemini ${res.status}: ${body.slice(0, 300)}`);
        }

        const data = await res.json();
        const text = (data.candidates?.[0]?.content?.parts || [])
          .map(p => p.text || '').join('').trim();
        if (!text) {
          lastErr = new Error(`Gemini ${model} returned no text (finish: ${data.candidates?.[0]?.finishReason})`);
          continue;
        }
        return text;
      } catch (err) {
        lastErr = err;
      }
    }
    // Every model was busy this round — back off and try the rotation again.
    if (round < MAX_ROUNDS - 1) await sleep(1500 * (round + 1));
  }
  throw lastErr || new Error('Gemini: all models failed');
}

// Stage definitions — determines tone and urgency
const STAGES = {
  1: { label: 'friendly reminder', daysOverdue: 1  },
  2: { label: 'firm follow-up',   daysOverdue: 7  },
  3: { label: 'final notice',     daysOverdue: 21 },
};

function formatMoney(amount, currency = 'ZAR') {
  try {
    return new Intl.NumberFormat('en-ZA', { style: 'currency', currency }).format(Number(amount));
  } catch {
    return `${currency || ''}${Number(amount).toLocaleString('en-ZA', { minimumFractionDigits: 2 })}`;
  }
}

async function generateChaseMessage({ invoice, stage, channel, senderName }) {
  const stageInfo = STAGES[stage];
  const amountStr = formatMoney(invoice.amount_due, invoice.currency);
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
  ? `Format: plain text only, no markdown, no subject line, 3-5 sentences max. Greet the client by name — open with "Hi ${invoice.contact_name},".`
  : `Format: include a Subject: line first, then a blank line, then the email body. Address the client as "${invoice.contact_name}". Sign off as "${senderName}".`}

CRITICAL: Never output bracketed placeholders such as [Name], [Your Name], or [Company]. Use the real names provided above. The client is "${invoice.contact_name}" and you are writing on behalf of "${senderName}".

Output only the message text — no explanation, no notes.`;

  return callGemini({ system, prompt, maxTokens: 600 });
}

// Determine which stage an invoice should be chased at, based on days overdue
// and what stage was last sent. `cadence` is configurable (defaults match the
// original 1/7/21-day schedule with a 6-day re-chase cooldown).
function nextChaseStage(invoice, cadence) {
  const c = cadence || {};
  const s1 = c.stage1 ?? 1, s2 = c.stage2 ?? 7, s3 = c.stage3 ?? 21, cool = c.cooldown ?? 6;
  const { days_overdue, chase_stage, last_chased_at, snoozed_until } = invoice;

  if (snoozed_until && new Date(snoozed_until) > new Date()) return null;

  const daysSinceLastChase = last_chased_at
    ? Math.floor((Date.now() - new Date(last_chased_at)) / 86400000)
    : 999;

  // Don't re-chase within the cooldown window of the last message
  if (daysSinceLastChase < cool) return null;

  if (chase_stage === 0 && days_overdue >= s1) return 1;
  if (chase_stage === 1 && days_overdue >= s2) return 2;
  if (chase_stage === 2 && days_overdue >= s3) return 3;

  return null;
}

module.exports = { generateChaseMessage, nextChaseStage, STAGES, formatMoney };
