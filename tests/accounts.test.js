const { test } = require('node:test');
const assert = require('node:assert');
const { hashPassword, verifyPassword } = require('../src/accounts');

test('hashPassword + verifyPassword round-trip', () => {
  const stored = hashPassword('correct horse battery staple');
  assert.ok(stored.includes(':'), 'stored hash is salt:hash');
  assert.strictEqual(verifyPassword('correct horse battery staple', stored), true);
  assert.strictEqual(verifyPassword('wrong password', stored), false);
});

test('verifyPassword rejects malformed / empty stored values', () => {
  assert.strictEqual(verifyPassword('x', ''), false);
  assert.strictEqual(verifyPassword('x', null), false);
  assert.strictEqual(verifyPassword('x', 'no-colon-here'), false);
});

test('same password hashes differently each time (random salt)', () => {
  assert.notStrictEqual(hashPassword('same'), hashPassword('same'));
});
