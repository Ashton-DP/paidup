const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseCsv, csvToObjects, mapRowToInvoice, normalizeDate, csvToInvoices,
} = require('../src/csv');

test('parseCsv handles quoted fields with embedded commas and quotes', () => {
  const rows = parseCsv('a,b,c\n"Smith, John","say ""hi""",3');
  assert.deepStrictEqual(rows[0], ['a', 'b', 'c']);
  assert.deepStrictEqual(rows[1], ['Smith, John', 'say "hi"', '3']);
});

test('parseCsv ignores blank lines', () => {
  const rows = parseCsv('a,b\n\n1,2\n\n');
  assert.strictEqual(rows.length, 2);
});

test('csvToObjects keys rows by lowercased headers', () => {
  const objs = csvToObjects('Name,Amount\nAcme,100');
  assert.deepStrictEqual(objs, [{ name: 'Acme', amount: '100' }]);
});

test('normalizeDate handles ISO and SA day-first formats', () => {
  assert.strictEqual(normalizeDate('2026-06-09'), '2026-06-09');
  assert.strictEqual(normalizeDate('09/06/2026'), '2026-06-09'); // DD/MM/YYYY
  assert.strictEqual(normalizeDate('9-6-26'), '2026-06-09');
  assert.strictEqual(normalizeDate('rubbish'), null);
  assert.strictEqual(normalizeDate(''), null);
});

test('mapRowToInvoice maps flexible header aliases', () => {
  const inv = mapRowToInvoice({
    client: 'Acme Ltd', email: 'a@b.co.za', mobile: '082 123 4567',
    reference: 'INV-9', total: 'R 1 250.50', currency: 'zar', due: '01/05/2026',
  });
  assert.strictEqual(inv.contact_name, 'Acme Ltd');
  assert.strictEqual(inv.contact_email, 'a@b.co.za');
  assert.strictEqual(inv.contact_phone, '082 123 4567');
  assert.strictEqual(inv.invoice_number, 'INV-9');
  assert.strictEqual(inv.amount_due, 1250.5);
  assert.strictEqual(inv.currency, 'ZAR');
  assert.strictEqual(inv.due_date, '2026-05-01');
});

test('csvToInvoices keeps valid rows and counts skipped ones', () => {
  const csv = [
    'name,amount,due_date,email',
    'Good Co,500,2026-05-01,good@co.za',   // valid
    'No Amount,,2026-05-01,x@y.za',         // skipped — no amount
    'No Date,500,,x@y.za',                  // skipped — no due date
    ',500,2026-05-01,x@y.za',               // skipped — no name
  ].join('\n');
  const { invoices, skipped } = csvToInvoices(csv);
  assert.strictEqual(invoices.length, 1);
  assert.strictEqual(invoices[0].contact_name, 'Good Co');
  assert.strictEqual(skipped, 3);
});
