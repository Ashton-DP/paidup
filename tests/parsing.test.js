const { test } = require('node:test');
const assert = require('node:assert');

const { formatZANumber, parseReplyIntent } = require('../src/whatsapp');
const { parseEmailMessage } = require('../src/email');
const { formatMoney } = require('../src/ai');
const { toDateOnly, assemblePhone, daysOverdue } = require('../src/xeroUtils');
const { phoneKey, emailKey } = require('../src/safety');

// ── SA phone normalisation → WhatsApp E.164 ──────────────────────────────────
test('formatZANumber handles every SA format', () => {
  assert.strictEqual(formatZANumber('082 123 4567'), 'whatsapp:+27821234567');
  assert.strictEqual(formatZANumber('0821234567'), 'whatsapp:+27821234567');
  assert.strictEqual(formatZANumber('27821234567'), 'whatsapp:+27821234567');
  assert.strictEqual(formatZANumber('+27 82 123 4567'), 'whatsapp:+27821234567');
  assert.strictEqual(formatZANumber('821234567'), 'whatsapp:+27821234567');
});
test('formatZANumber rejects junk / empty', () => {
  assert.strictEqual(formatZANumber(''), null);
  assert.strictEqual(formatZANumber(null), null);
  assert.strictEqual(formatZANumber('abc'), null);
});

// ── Reply intent classification ──────────────────────────────────────────────
test('parseReplyIntent classifies replies', () => {
  assert.strictEqual(parseReplyIntent('I have paid it via EFT'), 'paid');
  assert.strictEqual(parseReplyIntent('can I pay next friday'), 'snooze');
  assert.strictEqual(parseReplyIntent('this invoice is incorrect'), 'dispute');
  assert.strictEqual(parseReplyIntent('STOP'), 'stop');
  assert.strictEqual(parseReplyIntent('hello there'), 'unknown');
});

// ── Email subject/body split ─────────────────────────────────────────────────
test('parseEmailMessage splits subject and body', () => {
  const r = parseEmailMessage('Subject: Payment reminder\n\nHi there,\nPlease pay.');
  assert.strictEqual(r.subject, 'Payment reminder');
  assert.ok(r.body.includes('Hi there,'));
  assert.ok(!r.body.toLowerCase().includes('subject:'));
});
test('parseEmailMessage falls back when no subject line', () => {
  const r = parseEmailMessage('Just a body with no subject');
  assert.strictEqual(r.subject, 'Invoice payment reminder');
  assert.ok(r.body.includes('Just a body'));
});

// ── Currency formatting ──────────────────────────────────────────────────────
test('formatMoney uses the right currency symbol', () => {
  assert.match(formatMoney(8500, 'ZAR'), /R/);
  assert.match(formatMoney(250, 'USD'), /\$/);
  assert.ok(formatMoney(8500, 'ZAR').replace(/\s/g, '').includes('8500'));
});

// ── Xero data parsing ────────────────────────────────────────────────────────
test('toDateOnly normalises Date and string', () => {
  assert.strictEqual(toDateOnly(new Date('2026-06-09T12:00:00Z')), '2026-06-09');
  assert.strictEqual(toDateOnly('2026-06-09T00:00:00+02:00'), '2026-06-09');
  assert.strictEqual(toDateOnly(null), null);
});
test('assemblePhone prefers MOBILE and builds E.164', () => {
  assert.strictEqual(assemblePhone([
    { phoneType: 'DEFAULT', phoneNumber: '111', phoneCountryCode: '27', phoneAreaCode: '11' },
    { phoneType: 'MOBILE', phoneNumber: '1234567', phoneCountryCode: '27', phoneAreaCode: '82' },
  ]), '+27821234567');
  assert.strictEqual(assemblePhone([]), null);
  assert.strictEqual(assemblePhone([{ phoneType: 'MOBILE', phoneNumber: '' }]), null);
});
test('daysOverdue never goes negative', () => {
  const future = new Date(Date.now() + 5 * 86400000).toISOString();
  assert.strictEqual(daysOverdue(future), 0);
  const past = new Date(Date.now() - 3 * 86400000).toISOString();
  assert.ok(daysOverdue(past) >= 2);
});

// ── Opt-out matching keys ────────────────────────────────────────────────────
test('phoneKey collapses formats to the last 9 digits', () => {
  assert.strictEqual(phoneKey('082 123 4567'), '821234567');
  assert.strictEqual(phoneKey('whatsapp:+27821234567'), '821234567');
  assert.strictEqual(phoneKey('123'), null);
  assert.strictEqual(phoneKey(null), null);
});
test('emailKey lowercases and trims', () => {
  assert.strictEqual(emailKey('  Foo@BAR.com '), 'foo@bar.com');
  assert.strictEqual(emailKey('not-an-email'), null);
  assert.strictEqual(emailKey(null), null);
});
