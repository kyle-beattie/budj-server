import { X509Certificate, createPublicKey } from 'node:crypto';
import { decodeProtectedHeader, importX509, jwtVerify } from 'jose';
import { APPLE_ROOT_CA_G3_PEM } from './apple-root-ca.js';

/**
 * Verification for every JWS Apple signs: App Store Server Notifications V2 and
 * the signed transactions the app submits after purchase.
 *
 * **A permissive implementation here grants free subscriptions to anyone**, so
 * the order of operations matters and every step is mandatory:
 *
 * 1. Read `x5c` from the protected header — the chain Apple claims.
 * 2. Walk it: each certificate must be issued by, and verify against, the next.
 * 3. The last one must be **byte-identical** to our pinned Apple root. Matching
 *    on subject or issuer name instead would accept any self-signed certificate
 *    claiming to be Apple, which is trivial to mint.
 * 4. Every certificate must be inside its validity window.
 * 5. Only then, verify the payload signature with the leaf's public key.
 *
 * Reversing 4 and 5, or skipping 3, is the classic way this gets built wrong:
 * the signature verifies fine against a chain the attacker generated.
 */

export class AppleJwsVerificationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AppleJwsVerificationError';
  }
}

const ALGORITHM = 'ES256';
/** Apple's chain is leaf → intermediate → root. Bound generously, not exactly. */
const MAX_CHAIN_LENGTH = 5;

function pemFromBase64Der(base64Der: string): string {
  const wrapped = base64Der.replace(/(.{64})/g, '$1\n');
  return `-----BEGIN CERTIFICATE-----\n${wrapped}\n-----END CERTIFICATE-----`;
}

function parseCertificate(base64Der: string, position: number): X509Certificate {
  try {
    return new X509Certificate(pemFromBase64Der(base64Der));
  } catch (cause) {
    throw new AppleJwsVerificationError(
      `Certificate at position ${position} of the x5c chain is not parseable`,
      { cause },
    );
  }
}

function assertWithinValidity(certificate: X509Certificate, at: Date, position: number): void {
  const notBefore = new Date(certificate.validFrom);
  const notAfter = new Date(certificate.validTo);

  if (at < notBefore || at > notAfter) {
    throw new AppleJwsVerificationError(
      `Certificate at position ${position} of the x5c chain is outside its validity window`,
    );
  }
}

export interface VerifyOptions {
  /** Evaluate certificate validity at this instant. Defaults to now. */
  at?: Date;
  /**
   * Trust anchor, defaulting to the pinned Apple root.
   *
   * Overridable **only** so the tests can exercise the positive path: nobody
   * can mint a chain under Apple's real root, so without this seam the happy
   * case would be untestable and only the rejections would ever run. Production
   * callers pass nothing, and `test/apple-jws.test.ts` asserts that the default
   * rejects a chain built under any other root.
   */
  rootPem?: string;
}

/**
 * Validate the x5c chain to the pinned Apple root and return the leaf.
 *
 * Exported for its own tests: this is the half worth attacking.
 */
export function verifyCertificateChain(
  x5c: string[],
  { at = new Date(), rootPem = APPLE_ROOT_CA_G3_PEM }: VerifyOptions = {},
): X509Certificate {
  if (x5c.length < 2) {
    throw new AppleJwsVerificationError(
      'x5c chain must contain at least a leaf and the root certificate',
    );
  }
  if (x5c.length > MAX_CHAIN_LENGTH) {
    throw new AppleJwsVerificationError('x5c chain is implausibly long');
  }

  const chain = x5c.map((entry, index) => parseCertificate(entry, index));
  chain.forEach((certificate, index) => assertWithinValidity(certificate, at, index));

  // The anchor must be *our* certificate, not one that merely says "Apple".
  const presentedRoot = chain[chain.length - 1]!;
  const pinnedRoot = new X509Certificate(rootPem);

  if (!presentedRoot.raw.equals(pinnedRoot.raw)) {
    throw new AppleJwsVerificationError(
      'x5c chain does not terminate at the pinned Apple root certificate',
    );
  }

  // Each certificate must be issued by the next one along, and its signature
  // must actually verify under that issuer's key. `checkIssued` alone compares
  // names; `verify` is what makes it mean anything.
  for (let index = 0; index < chain.length - 1; index += 1) {
    const subject = chain[index]!;
    const issuer = chain[index + 1]!;

    if (!issuer.ca) {
      throw new AppleJwsVerificationError(
        `Certificate at position ${index + 1} of the x5c chain is not a CA but signs another`,
      );
    }
    if (!subject.checkIssued(issuer)) {
      throw new AppleJwsVerificationError(
        `Certificate at position ${index} of the x5c chain was not issued by position ${index + 1}`,
      );
    }
    if (!subject.verify(issuer.publicKey)) {
      throw new AppleJwsVerificationError(
        `Certificate at position ${index} of the x5c chain fails signature verification`,
      );
    }
  }

  return chain[0]!;
}

/**
 * Verify a signed payload from Apple and return its claims.
 *
 * `options` exists for the tests only — see `VerifyOptions`. Production calls
 * this with the payload and nothing else.
 */
export async function verifyAppleJws<T>(jws: string, options: VerifyOptions = {}): Promise<T> {
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(jws);
  } catch (cause) {
    throw new AppleJwsVerificationError('Payload is not a well-formed JWS', { cause });
  }

  if (header.alg !== ALGORITHM) {
    // Never take the algorithm from the token itself beyond rejecting it —
    // `none` and HMAC confusion both live in this gap.
    throw new AppleJwsVerificationError(
      `Unexpected signing algorithm '${String(header.alg)}', expected ${ALGORITHM}`,
    );
  }

  const x5c = header.x5c;
  if (!Array.isArray(x5c) || x5c.length === 0) {
    throw new AppleJwsVerificationError('JWS header carries no x5c certificate chain');
  }

  const leaf = verifyCertificateChain(x5c, options);
  const publicKey = await importX509(leaf.toString(), ALGORITHM);

  try {
    const { payload } = await jwtVerify(jws, publicKey, {
      algorithms: [ALGORITHM],
      // Apple's payloads carry no exp/nbf; the certificate window is the
      // freshness control, and it was checked above.
      clockTolerance: 0,
    });
    return payload as T;
  } catch (cause) {
    throw new AppleJwsVerificationError('JWS signature does not verify against its leaf certificate', {
      cause,
    });
  }
}

/** Public key of a leaf, exposed for tests that need to assert identity. */
export function leafPublicKey(certificate: X509Certificate): ReturnType<typeof createPublicKey> {
  return createPublicKey(certificate.publicKey);
}
