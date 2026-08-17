import { X509Certificate, createPrivateKey } from 'node:crypto';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  AppleJwsVerificationError,
  verifyAppleJws,
  verifyCertificateChain,
} from '../src/modules/billing/apple-jws.js';
import {
  APPLE_ROOT_CA_G3_PEM,
  APPLE_ROOT_CA_G3_SHA256,
} from '../src/modules/billing/apple-root-ca.js';
import {
  budjTestRootPem,
  intermediateDer,
  leafDer,
  leafPrivateKeyPem,
  rogueChain,
  rogueLeafPrivateKeyPem,
  rootDer,
  validChain,
} from './fixtures/apple-jws-chain.js';

/**
 * The verifier that stands between anyone on the internet and a free
 * subscription. Every test here is a way it could be built permissively.
 */

const testAnchor = { rootPem: budjTestRootPem };

async function signPayload(
  payload: Record<string, unknown>,
  x5c: string[],
  privateKeyPem = leafPrivateKeyPem,
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256', x5c })
    .sign(createPrivateKey(privateKeyPem));
}

describe('the pinned root certificate', () => {
  /** An edit to the embedded bytes must fail loudly, not widen trust quietly. */
  it('is Apple Root CA - G3, unmodified', () => {
    const certificate = new X509Certificate(APPLE_ROOT_CA_G3_PEM);

    expect(certificate.fingerprint256).toBe(APPLE_ROOT_CA_G3_SHA256);
    expect(certificate.subject).toContain('Apple Root CA - G3');
    // Self-signed: a root that is not its own issuer is not a root.
    expect(certificate.issuer).toBe(certificate.subject);
    expect(certificate.ca).toBe(true);
  });
});

describe('verifyCertificateChain', () => {
  it('accepts a well-formed chain terminating at the trusted root', () => {
    const leaf = verifyCertificateChain(validChain, testAnchor);

    expect(leaf.subject).toContain('Budj Test Leaf');
  });

  /**
   * The headline assertion: the fixture chain is perfectly valid, internally
   * consistent, and signed all the way up — and the real verifier rejects it,
   * because its root is not Apple's.
   */
  it('rejects that same valid chain under the real Apple anchor', () => {
    expect(() => verifyCertificateChain(validChain)).toThrow(
      /does not terminate at the pinned Apple root/,
    );
  });

  /**
   * A self-signed certificate whose subject and issuer are byte-for-byte
   * Apple's. Anchoring trust on the distinguished name accepts this; comparing
   * the certificate does not.
   */
  it('rejects an impostor root carrying Apple’s exact name', () => {
    const impostor = new X509Certificate(
      `-----BEGIN CERTIFICATE-----\n${rogueChain[1]!.replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----`,
    );
    // Prove the impostor really is name-identical, or the test proves nothing.
    // Compared as a set: openssl emits the RDNs in the order they were given,
    // and attribute ordering is not what a name-matching verifier would key on.
    const rdns = (certificate: X509Certificate) => certificate.subject.split('\n').sort();
    expect(rdns(impostor)).toEqual(rdns(new X509Certificate(APPLE_ROOT_CA_G3_PEM)));
    // ...and that it is genuinely self-signed, as a root claims to be.
    expect(rdns(impostor)).toEqual(impostor.issuer.split('\n').sort());

    expect(() => verifyCertificateChain(rogueChain)).toThrow(
      /does not terminate at the pinned Apple root/,
    );
  });

  it('rejects a chain whose middle certificate did not sign the leaf', () => {
    // Leaf and root are genuine, but the intermediate that actually signed the
    // leaf has been dropped, so leaf is presented as issued by root.
    expect(() => verifyCertificateChain([leafDer, rootDer], testAnchor)).toThrow(
      AppleJwsVerificationError,
    );
  });

  it('rejects a lone self-signed certificate presented as its own chain', () => {
    expect(() => verifyCertificateChain([leafDer], testAnchor)).toThrow(/at least a leaf and the root/);
  });

  it('rejects a certificate outside its validity window', () => {
    const longAfterExpiry = new Date('2099-01-01T00:00:00Z');

    expect(() => verifyCertificateChain(validChain, { ...testAnchor, at: longAfterExpiry })).toThrow(
      /outside its validity window/,
    );
  });

  it('rejects a certificate before it becomes valid', () => {
    expect(() =>
      verifyCertificateChain(validChain, { ...testAnchor, at: new Date('2000-01-01T00:00:00Z') }),
    ).toThrow(/outside its validity window/);
  });

  it('rejects unparseable certificate data', () => {
    expect(() => verifyCertificateChain(['not-base64-der', rootDer], testAnchor)).toThrow(
      /not parseable/,
    );
  });

  it('rejects an implausibly long chain', () => {
    const padded = [leafDer, intermediateDer, intermediateDer, intermediateDer, intermediateDer, rootDer];

    expect(() => verifyCertificateChain(padded, testAnchor)).toThrow(/implausibly long/);
  });
});

describe('verifyAppleJws', () => {
  it('returns the payload of a properly signed notification', async () => {
    const jws = await signPayload({ notificationType: 'DID_RENEW', notificationUUID: 'abc' }, validChain);

    const payload = await verifyAppleJws<{ notificationType: string; notificationUUID: string }>(
      jws,
      testAnchor,
    );

    expect(payload).toMatchObject({ notificationType: 'DID_RENEW', notificationUUID: 'abc' });
  });

  it('rejects a payload signed by a key that is not the leaf’s', async () => {
    // Valid, trusted chain in the header — but signed with someone else's key.
    const jws = await signPayload({ notificationType: 'DID_RENEW' }, validChain, rogueLeafPrivateKeyPem);

    await expect(verifyAppleJws(jws, testAnchor)).rejects.toThrow(/signature does not verify/);
  });

  it('rejects a tampered payload', async () => {
    const jws = await signPayload({ notificationType: 'EXPIRED' }, validChain);
    const [header, , signature] = jws.split('.') as [string, string, string];

    const forged = Buffer.from(JSON.stringify({ notificationType: 'SUBSCRIBED' })).toString(
      'base64url',
    );

    await expect(verifyAppleJws(`${header}.${forged}.${signature}`, testAnchor)).rejects.toThrow(
      /signature does not verify/,
    );
  });

  /** `alg: none` is the oldest JWT bug there is. */
  it('rejects an unsigned token', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', x5c: validChain })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ notificationType: 'SUBSCRIBED' })).toString(
      'base64url',
    );

    await expect(verifyAppleJws(`${header}.${payload}.`, testAnchor)).rejects.toThrow(
      /Unexpected signing algorithm/,
    );
  });

  it('rejects an algorithm swap away from ES256', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', x5c: validChain })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ notificationType: 'SUBSCRIBED' })).toString(
      'base64url',
    );

    await expect(verifyAppleJws(`${header}.${payload}.c2ln`, testAnchor)).rejects.toThrow(
      /Unexpected signing algorithm/,
    );
  });

  it('rejects a token carrying no certificate chain', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ notificationType: 'SUBSCRIBED' })).toString(
      'base64url',
    );

    await expect(verifyAppleJws(`${header}.${payload}.c2ln`, testAnchor)).rejects.toThrow(
      /no x5c certificate chain/,
    );
  });

  it.each([
    ['an empty string', ''],
    ['arbitrary text', 'hello'],
    ['too few segments', 'aaa.bbb'],
  ])('rejects %s', async (_label, jws) => {
    await expect(verifyAppleJws(jws, testAnchor)).rejects.toThrow(AppleJwsVerificationError);
  });

  it('rejects a correctly signed payload under the real Apple anchor', async () => {
    const jws = await signPayload({ notificationType: 'SUBSCRIBED' }, validChain);

    await expect(verifyAppleJws(jws)).rejects.toThrow(/does not terminate at the pinned Apple root/);
  });
});
