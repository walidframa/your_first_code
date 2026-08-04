/**
 * Encryption for the handful of things the shop keeps on a customer's behalf.
 *
 * A phone shop sets up the iCloud or Google account for the customer, and the
 * customer comes back six months later having forgotten it. Keeping it is the
 * service. Keeping it in a column anyone can read is not: a copy of the file —
 * a backup on a laptop, a stolen machine — would hand over live accounts to
 * whoever has it.
 *
 * So it is encrypted at rest with a key the database does not contain. Losing
 * the key loses the passwords, which is the correct trade: without it the file
 * on its own is worth nothing.
 */

import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';

let cachedKey = null;

/**
 * The key, from `ACCOUNT_SECRET`.
 *
 * It deliberately does not fall back to `JWT_SECRET`: one is rotated when a
 * session leaks, the other must not be, and sharing them means rotating either
 * makes every stored password unreadable.
 */
function key() {
  if (cachedKey) return cachedKey;

  const secret = process.env.ACCOUNT_SECRET;
  if (secret && secret.length >= 32) {
    cachedKey = crypto.createHash('sha256').update(secret).digest();
    return cachedKey;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'ACCOUNT_SECRET must be set to at least 32 characters to store customer account passwords.',
    );
  }

  /*
   * Development gets a per-process key, so anything saved becomes unreadable on
   * restart. That is a nuisance on purpose: it is the reminder to set the
   * variable before this holds anything real.
   */
  cachedKey = crypto.randomBytes(32);
  console.warn(
    '\x1b[33m[warn] ACCOUNT_SECRET is not set — customer account passwords are encrypted with a\n' +
      '       throwaway key and will not survive a restart.\x1b[0m',
  );
  return cachedKey;
}

/** Encrypt a string. Returns `v1.iv.tag.ciphertext`, all base64url. */
export function encryptSecret(plain) {
  const text = String(plain ?? '');
  if (!text) return null;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(
    '.',
  );
}

/**
 * Decrypt what `encryptSecret` produced.
 *
 * Returns null rather than throwing when it cannot be read — after a restart in
 * development, or if the key has changed, the row is simply unreadable, and a
 * screen listing twenty accounts should not fail entirely because one of them
 * predates the current key.
 */
export function decryptSecret(blob) {
  if (!blob) return null;
  try {
    const [version, iv, tag, ciphertext] = String(blob).split('.');
    if (version !== 'v1') return null;

    const decipher = crypto.createDecipheriv(ALGORITHM, key(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}
