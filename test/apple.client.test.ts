import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AppleExchangeError,
  createAppleClientSecret,
  exchangeAuthorizationCode,
  type AppleCredentials,
} from '../src/modules/auth/apple.client.js';

const { privateKey, publicKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const credentials: AppleCredentials = {
  teamId: 'TEAM123456',
  keyId: 'KEY7890123',
  privateKey,
  clientId: 'com.example.budj',
};

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

describe('createAppleClientSecret', () => {
  it('produces the header Apple requires', () => {
    const [header] = createAppleClientSecret(credentials).split('.') as [string];

    expect(decodeSegment(header)).toMatchObject({ alg: 'ES256', kid: 'KEY7890123', typ: 'JWT' });
  });

  it('claims the team as issuer and the bundle id as subject', () => {
    const now = new Date('2026-08-17T00:00:00Z');
    const [, payload] = createAppleClientSecret(credentials, now).split('.') as [string, string];

    expect(decodeSegment(payload)).toMatchObject({
      iss: 'TEAM123456',
      sub: 'com.example.budj',
      aud: 'https://appleid.apple.com',
      iat: 1786924800,
    });
  });

  /** Apple rejects a client secret living longer than six months. */
  it('expires comfortably inside Apple’s six month ceiling', () => {
    const now = new Date('2026-08-17T00:00:00Z');
    const [, payload] = createAppleClientSecret(credentials, now).split('.') as [string, string];
    const { iat, exp } = decodeSegment(payload) as { iat: number; exp: number };

    const lifetimeDays = (exp - iat) / 86_400;
    expect(lifetimeDays).toBeGreaterThan(0);
    expect(lifetimeDays).toBeLessThan(180);
  });

  /**
   * The signature must be the raw r‖s pair, not DER. OpenSSL emits DER by
   * default and Apple answers a DER signature with an opaque `invalid_client`,
   * so this asserts both the length and that it actually verifies.
   */
  it('signs with a JOSE-format ES256 signature', () => {
    const token = createAppleClientSecret(credentials);
    const [header, payload, signature] = token.split('.') as [string, string, string];

    const raw = Buffer.from(signature, 'base64url');
    expect(raw.byteLength).toBe(64);

    const verified = createVerify('SHA256')
      .update(`${header}.${payload}`)
      .verify(
        { key: createPublicKey(publicKey), dsaEncoding: 'ieee-p1363' },
        raw,
      );
    expect(verified).toBe(true);
  });

  it('does not verify against a different key', () => {
    const other = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });

    const token = createAppleClientSecret(credentials);
    const [header, payload, signature] = token.split('.') as [string, string, string];

    const verified = createVerify('SHA256')
      .update(`${header}.${payload}`)
      .verify(
        { key: createPublicKey(other.publicKey), dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64url'),
      );
    expect(verified).toBe(false);
  });
});

describe('exchangeAuthorizationCode', () => {
  function stubFetch(
    response: { status: number; body: unknown },
    capture?: (url: string, init: RequestInit) => void,
  ): typeof fetch {
    return (async (url: string, init: RequestInit) => {
      capture?.(url, init);
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        json: async () => response.body,
      };
    }) as unknown as typeof fetch;
  }

  it('posts the grant to Apple with a freshly minted client secret', async () => {
    let seenUrl = '';
    let seenBody = '';

    await exchangeAuthorizationCode(
      credentials,
      'code-abc',
      stubFetch({ status: 200, body: { refresh_token: 'apple-refresh' } }, (url, init) => {
        seenUrl = url;
        seenBody = String(init.body);
      }),
    );

    const form = new URLSearchParams(seenBody);
    expect(seenUrl).toBe('https://appleid.apple.com/auth/token');
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('code-abc');
    expect(form.get('client_id')).toBe('com.example.budj');
    expect(form.get('client_secret')?.split('.')).toHaveLength(3);
  });

  it('returns the refresh token', async () => {
    const result = await exchangeAuthorizationCode(
      credentials,
      'code-abc',
      stubFetch({ status: 200, body: { refresh_token: 'apple-refresh' } }),
    );

    expect(result).toEqual({ refreshToken: 'apple-refresh' });
  });

  /** What a replayed or expired code looks like coming back from Apple. */
  it('surfaces Apple’s error code on rejection', async () => {
    await expect(
      exchangeAuthorizationCode(
        credentials,
        'already-used',
        stubFetch({ status: 400, body: { error: 'invalid_grant' } }),
      ),
    ).rejects.toMatchObject({ appleCode: 'invalid_grant' });
  });

  it('treats a success with no refresh token as a failure', async () => {
    await expect(
      exchangeAuthorizationCode(
        credentials,
        'code-abc',
        stubFetch({ status: 200, body: { access_token: 'irrelevant' } }),
      ),
    ).rejects.toBeInstanceOf(AppleExchangeError);
  });

  it('does not invent an error code when Apple sends none', async () => {
    await expect(
      exchangeAuthorizationCode(credentials, 'code-abc', stubFetch({ status: 503, body: {} })),
    ).rejects.toMatchObject({ appleCode: 'http_503' });
  });
});
