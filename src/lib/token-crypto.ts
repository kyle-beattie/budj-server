import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encryption for long-lived provider credentials at rest — the Akahu access
 * token and Apple's refresh token.
 *
 * Both live in tables with RLS enabled and no policies, so no user client can
 * reach them. This is the second lock: the key lives in the environment rather
 * than in Postgres, so a database dump on its own does not yield bank access
 * for every user.
 *
 * ## Ciphertext format
 *
 * ```
 *   v1:<base64url( iv | authTag | ciphertext )>
 * ```
 *
 * The version prefix is the whole reason rotation is possible later. A stored
 * value names the key that produced it, so a new key can be introduced and old
 * values keep decrypting until they are rewritten — no flag day, no window
 * where half the rows are unreadable. Adding a key without the prefix would
 * make rotation a migration with an outage in the middle.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt rather
 * than returning plausible bytes.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION_PATTERN = /^v[1-9]\d*$/;

export class TokenCryptoError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TokenCryptoError';
  }
}

export interface Keyring {
  /** Version used for new ciphertext. */
  readonly activeVersion: string;
  readonly keys: ReadonlyMap<string, Buffer>;
}

/**
 * Parse `v1:<base64>` — or `v2:<base64>,v1:<base64>` mid-rotation.
 *
 * The **first** entry is the active one: new values are encrypted with it, and
 * every listed version can still be decrypted. To rotate, generate a new key,
 * put it first, and leave the old one in place until nothing references it.
 */
export function parseKeyring(raw: string): Keyring {
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length === 0) {
    throw new TokenCryptoError('Token encryption key is empty');
  }

  const keys = new Map<string, Buffer>();
  let activeVersion: string | undefined;

  for (const entry of entries) {
    const separator = entry.indexOf(':');
    if (separator === -1) {
      throw new TokenCryptoError(
        'Token encryption key must be "<version>:<base64 key>", e.g. v1:aGVsbG8...',
      );
    }

    const version = entry.slice(0, separator);
    if (!VERSION_PATTERN.test(version)) {
      throw new TokenCryptoError(`Token encryption key version '${version}' must look like v1, v2, …`);
    }
    if (keys.has(version)) {
      throw new TokenCryptoError(`Token encryption key version '${version}' is listed twice`);
    }

    const key = Buffer.from(entry.slice(separator + 1), 'base64');
    if (key.byteLength !== KEY_BYTES) {
      throw new TokenCryptoError(
        `Token encryption key '${version}' must be ${KEY_BYTES} bytes once base64-decoded, got ${key.byteLength}`,
      );
    }

    keys.set(version, key);
    activeVersion ??= version;
  }

  return { activeVersion: activeVersion!, keys };
}

/** Encrypt with the keyring's active version, tagging the output with it. */
export function encryptToken(keyring: Keyring, plaintext: string): string {
  const key = keyring.keys.get(keyring.activeVersion);
  if (!key) {
    throw new TokenCryptoError(`Active key version '${keyring.activeVersion}' is missing from the keyring`);
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const payload = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);

  return `${keyring.activeVersion}:${payload.toString('base64url')}`;
}

/**
 * Decrypt any version the keyring still holds.
 *
 * An unknown version throws rather than returning null: it means the key that
 * wrote this row is gone, which is a configuration emergency and not a
 * per-record problem to swallow.
 */
export function decryptToken(keyring: Keyring, stored: string): string {
  const separator = stored.indexOf(':');
  if (separator === -1) {
    throw new TokenCryptoError('Stored token is not in "<version>:<payload>" form');
  }

  const version = stored.slice(0, separator);
  const key = keyring.keys.get(version);
  if (!key) {
    throw new TokenCryptoError(
      `Stored token was encrypted with key version '${version}', which is not configured`,
    );
  }

  const payload = Buffer.from(stored.slice(separator + 1), 'base64url');
  if (payload.byteLength <= IV_BYTES + TAG_BYTES) {
    throw new TokenCryptoError('Stored token payload is too short to be valid');
  }

  const iv = payload.subarray(0, IV_BYTES);
  const authTag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = payload.subarray(IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (cause) {
    // GCM authentication failed: the ciphertext or the tag was altered.
    throw new TokenCryptoError('Stored token failed authentication and may have been tampered with', {
      cause,
    });
  }
}

/** Convenience for the runbook: `node -e "..."` to mint a fresh key. */
export function generateKeyMaterial(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}
