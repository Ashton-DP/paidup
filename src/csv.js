/**
 * Pure CSV parsing + invoice mapping. No I/O — easy to unit-test.
 *
 * Lets PaidUp ingest overdue invoices from ANY source (Sage, QuickBooks, a
 * spreadsheet) without a Xero connection. Headers are matched flexibly and
 * case-insensitively against common aliases.
 */

// RFC-4180-ish parser: handles quoted fields, embedded commas/quotes, CRLF/LF.
function parseCsv(text) {
  const s = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

// Turn CSV text into header-keyed row objects (lowercased headers).
function csvToObjects(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map(h => h.trim().toLowerCase());
  return rows.slice(1).map(r => {
    const o = {};
    headers.forEach((h, i) => { o[h] = (r[i] || '').trim(); });
    return o;
  });
}

const ALIASES = {
  contact_name:   ['contact_name', 'name', 'client', 'customer', 'contact', 'company'],
  contact_email:  ['contact_email', 'email', 'e-mail', 'email_address'],
  contact_phone:  ['contact_phone', 'phone', 'mobile', 'cell', 'phone_number', 'tel'],
  invoice_number: ['invoice_number', 'invoice', 'invoice_no', 'reference', 'ref', 'number'],
  amount_due:     ['amount_due', 'amount', 'total', 'balance', 'due', 'value', 'outstanding'],
  currency:       ['currency', 'ccy'],
  due_date:       ['due_date', 'due', 'date', 'duedate', 'due date'],
};

function pick(obj, aliases) {
  for (const a of aliases) if (obj[a] != null && obj[a] !== '') return obj[a];
  return '';
}

// Normalise a date string to YYYY-MM-DD. Day-first (DD/MM/YYYY) is assumed for
// slash/dot/dash formats — the SA convention.
function normalizeDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = '20' + y;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const dt = new Date(s);
  return isNaN(dt) ? null : dt.toISOString().split('T')[0];
}

function mapRowToInvoice(obj) {
  const amount = parseFloat(String(pick(obj, ALIASES.amount_due)).replace(/[^0-9.\-]/g, ''));
  return {
    contact_name:   pick(obj, ALIASES.contact_name) || null,
    contact_email:  pick(obj, ALIASES.contact_email) || null,
    contact_phone:  pick(obj, ALIASES.contact_phone) || null,
    invoice_number: pick(obj, ALIASES.invoice_number) || null,
    amount_due:     Number.isFinite(amount) ? amount : null,
    currency:       (pick(obj, ALIASES.currency) || 'ZAR').toUpperCase(),
    due_date:       normalizeDate(pick(obj, ALIASES.due_date)),
  };
}

// An invoice needs a name, a positive amount, and a due date to be chaseable.
function isValidInvoice(inv) {
  return !!(inv.contact_name && inv.amount_due > 0 && inv.due_date);
}

// Full pipeline: CSV text → { invoices, skipped }.
function csvToInvoices(text) {
  const mapped = csvToObjects(text).map(mapRowToInvoice);
  const invoices = mapped.filter(isValidInvoice);
  return { invoices, skipped: mapped.length - invoices.length };
}

module.exports = {
  parseCsv, csvToObjects, mapRowToInvoice, normalizeDate, isValidInvoice, csvToInvoices,
};
