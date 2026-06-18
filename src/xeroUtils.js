/**
 * Pure helpers for parsing Xero data. No SDK / DB dependencies, so they can be
 * required and unit-tested directly in Node.
 */

// Whole days an invoice is past its due date (never negative).
function daysOverdue(dueDateStr) {
  const due = new Date(dueDateStr);
  const now = new Date();
  return Math.max(0, Math.floor((now - due) / 86400000));
}

// xero-node returns DueDate as a Date object on the invoice list but as an ISO
// string elsewhere — normalise to YYYY-MM-DD either way.
function toDateOnly(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().split('T')[0];
  return String(d).split('T')[0];
}

// Build a usable phone string from a Xero contact's phones array (which stores
// country / area / number separately). Prefer mobile, then default.
function assemblePhone(phones) {
  if (!phones || !phones.length) return null;
  const withNum = phones.filter(p => p.phoneNumber && p.phoneNumber.trim());
  if (!withNum.length) return null;
  const pick = withNum.find(p => p.phoneType === 'MOBILE')
            || withNum.find(p => p.phoneType === 'DEFAULT')
            || withNum[0];
  const cc  = (pick.phoneCountryCode || '').replace(/\D/g, '');
  const ac  = (pick.phoneAreaCode || '').replace(/\D/g, '');
  const num = (pick.phoneNumber || '').replace(/\D/g, '');
  const raw = cc ? `+${cc}${ac}${num}` : `${ac}${num}`;
  return raw || null;
}

module.exports = { daysOverdue, toDateOnly, assemblePhone };
