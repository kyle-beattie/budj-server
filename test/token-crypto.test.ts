import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptToken,
  encryptToken,
  generateKeyMaterial,
  parseKeyring,
  TokenCryptoError,
} from '../src/lib/token-crypto.js';

const KEY_ONE = randomBytes(32).toString('base64');
const KEY_TWO = randomBytes(32).toString('base64');

const v1 = parseKeyring(`v1:${KEY_ONE}`);
const v2ThenV1 = parseKeyring(`v2:${KEY_TWO},v1:${KEY_ONE}`);

describe('parseKeyring', () => {
  it('takes the first entry as the active version', () => {
    expect(v1.activeVersion).toBe('v1');
    expect(v2ThenV1.activeVersion).toBe('v2');
    expect([...v2ThenV1.keys.keys()]).toEqual(['v2', 'v1']);
  });

  it.each([
    ['an empty value', ''],
    ['a key with no version prefix', KEY_ONE],
    ['a version that is not vN', `latest:${KEY_ONE}`],
    ['the same version twice', `v1:${KEY_ONE},v1:${KEY_TWO}`],
    ['a key that is not 32 bytes', `v1:${randomBytes(16).toString('base64')}`],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseKeyring(raw)).toThrow(TokenCryptoError);
  });
});

describe('encryptToken / decryptToken', () => {
  it('round trips', () => {
    const secret = 'akahu_user_token_abc123';
    expect(decryptToken(v1, encryptToken(v1, secret))).toBe(secret);
  });

  it('round trips a token with unicode and newlines', () => {
    const secret = '-----BEGIN PRIVATE KEY-----\nüñïçødé\n-----END PRIVATE KEY-----\n';
    expect(decryptToken(v1, encryptToken(v1, secret))).toBe(secret);
  });

  it('tags the ciphertext with the key version that produced it', () => {
    expect(encryptToken(v1, 'secret').startsWith('v1:')).toBe(true);
    expect(encryptToken(v2ThenV1, 'secret').startsWith('v2:')).toBe(true);
  });

  /**
   * A fresh IV every time. Without this, two users with the same token produce
   * identical ciphertext and the table leaks equality.
   */
  it('never produces the same ciphertext twice', () => {
    const outputs = new Set(Array.from({ length: 20 }, () => encryptToken(v1, 'same-secret')));
    expect(outputs.size).toBe(20);
  });

  it('does not leave the plaintext recoverable from the stored value', () => {
    const stored = encryptToken(v1, 'akahu_user_token_abc123');
    expect(stored).not.toContain('akahu_user_token_abc123');
    expect(Buffer.from(stored.split(':')[1]!, 'base64url').toString('utf8')).not.toContain(
      'akahu_user_token',
    );
  });
});

describe('key rotation', () => {
  /**
   * The point of the version prefix: after rotation, values written by the old
   * key keep decrypting while new writes use the new one. No flag day.
   */
  it('decrypts an old version after a new key becomes active', () => {
    const beforeRotation = encryptToken(v1, 'written-under-v1');

    expect(decryptToken(v2ThenV1, beforeRotation)).toBe('written-under-v1');
    expect(encryptToken(v2ThenV1, 'written-under-v2').startsWith('v2:')).toBe(true);
  });

  it('refuses a version the keyring no longer holds', () => {
    const underV2 = encryptToken(v2ThenV1, 'secret');

    // v1 alone cannot read something v2 wrote.
    expect(() => decryptToken(v1, underV2)).toThrow(/key version 'v2', which is not configured/);
  });
});

describe('tamper resistance', () => {
  it('rejects a modified ciphertext rather than returning plausible bytes', () => {
    const stored = encryptToken(v1, 'akahu_user_token_abc123');
    const [version, payload] = stored.split(':') as [string, string];

    const bytes = Buffer.from(payload, 'base64url');
    bytes[bytes.length - 1] ^= 0xff;

    expect(() => decryptToken(v1, `${version}:${bytes.toString('base64url')}`)).toThrow(
      /failed authentication/,
    );
  });

  it('rejects a ciphertext re-tagged with a different key version', () => {
    const underV1 = encryptToken(v1, 'secret');
    const relabelled = underV1.replace(/^v1:/, 'v2:');

    expect(() => decryptToken(v2ThenV1, relabelled)).toThrow(TokenCryptoError);
  });

  it.each([
    ['no version separator', 'not-a-stored-token'],
    ['a payload too short to hold an iv and tag', 'v1:AAAA'],
  ])('rejects %s', (_label, stored) => {
    expect(() => decryptToken(v1, stored)).toThrow(TokenCryptoError);
  });
});

describe('generateKeyMaterial', () => {
  it('produces something parseKeyring accepts', () => {
    const keyring = parseKeyring(`v1:${generateKeyMaterial()}`);
    expect(decryptToken(keyring, encryptToken(keyring, 'secret'))).toBe('secret');
  });
});
