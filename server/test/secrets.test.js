/**
 * Encryption for the accounts the shop holds on a customer's behalf.
 *
 * The property that matters is not that it round-trips — it is that a copy of
 * the stored value, on its own, is worth nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ACCOUNT_SECRET = 'a-test-secret-that-is-long-enough-32';
const { encryptSecret, decryptSecret } = await import('../src/lib/secrets.js');

test('a password comes back exactly as it went in', () => {
  for (const plain of ['hunter2', 'p@ss word with spaces', 'كلمة السر', '🔐🔐']) {
    assert.equal(decryptSecret(encryptSecret(plain)), plain);
  }
});

test('the stored value does not contain the password', () => {
  const blob = encryptSecret('hunter2');
  assert.ok(!blob.includes('hunter2'));
  assert.match(blob, /^v1\./);
});

test('the same password encrypts differently every time', () => {
  // A shared nonce would let anyone holding the file see which customers chose
  // the same password.
  assert.notEqual(encryptSecret('hunter2'), encryptSecret('hunter2'));
});

test('a tampered value is refused rather than half-decrypted', () => {
  const blob = encryptSecret('hunter2');
  const [v, iv, tag, ct] = blob.split('.');
  assert.equal(decryptSecret([v, iv, tag, `${ct}AAAA`].join('.')), null);
  assert.equal(decryptSecret([v, iv, 'AAAAAAAAAAAAAAAAAAAAAA', ct].join('.')), null);
  assert.equal(decryptSecret('not-a-blob'), null);
});

test('nothing in, nothing out', () => {
  assert.equal(encryptSecret(''), null);
  assert.equal(encryptSecret(null), null);
  assert.equal(decryptSecret(null), null);
});
