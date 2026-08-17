import { createSign } from 'node:crypto';

/**
 * The small part of Apple's OAuth surface this server touches: mint a client
 * secret, and exchange an authorization code for a refresh token.
 *
 * This server never sees an Apple *identity* token — that goes straight from
 * the app to Supabase (D2). The authorization code is a different artifact and
 * comes here for one reason: Apple requires token revocation at account
 * deletion, that needs a refresh token, and Supabase does not expose one for
 * the native `signInWithIdToken` flow (D13).
 */

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_TOKEN_URL = `${APPLE_ISSUER}/auth/token`;

/** Apple's ceiling is six months; well short of it keeps rotation uneventful. */
const CLIENT_SECRET_TTL_SECONDS = 60 * 60 * 24 * 120;

export interface AppleCredentials {
  teamId: string;
  keyId: string;
  privateKey: string;
  clientId: string;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Apple's client secret is an ES256 JWT signed with the `.p8` key, not a shared
 * string. Signed here with `node:crypto` rather than a JWT library because the
 * whole construction is fifteen lines and this is *signing* — the dangerous
 * half of JWT handling is verification, and this server does none of Apple's.
 *
 * `dsaEncoding: 'ieee-p1363'` is load-bearing: OpenSSL emits DER by default and
 * JOSE requires the raw r‖s pair. A DER signature here is rejected by Apple
 * with an opaque `invalid_client`.
 */
export function createAppleClientSecret(
  credentials: AppleCredentials,
  now: Date = new Date(),
): string {
  const issuedAt = Math.floor(now.getTime() / 1000);

  const header = { alg: 'ES256', kid: credentials.keyId, typ: 'JWT' };
  const payload = {
    iss: credentials.teamId,
    iat: issuedAt,
    exp: issuedAt + CLIENT_SECRET_TTL_SECONDS,
    aud: APPLE_ISSUER,
    sub: credentials.clientId,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;

  const signature = createSign('SHA256')
    .update(signingInput)
    .sign({ key: credentials.privateKey, dsaEncoding: 'ieee-p1363' });

  return `${signingInput}.${base64url(signature)}`;
}

export interface AppleTokenExchange {
  refreshToken: string;
}

/** Apple's documented error shape for the token endpoint. */
interface AppleTokenErrorBody {
  error?: string;
  error_description?: string;
}

interface AppleTokenSuccessBody {
  refresh_token?: string;
}

export class AppleExchangeError extends Error {
  /** Apple's `error` code, e.g. `invalid_grant` when the code was already used. */
  readonly appleCode: string;

  constructor(appleCode: string, message: string) {
    super(message);
    this.name = 'AppleExchangeError';
    this.appleCode = appleCode;
  }
}

/**
 * Exchange the one-shot authorization code for a refresh token.
 *
 * The code is **single-use and expires in about five minutes**, so there is no
 * retry to build here: a failure is final for that sign-in and the only
 * recovery is the user authorising again.
 */
export async function exchangeAuthorizationCode(
  credentials: AppleCredentials,
  authorizationCode: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AppleTokenExchange> {
  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: createAppleClientSecret(credentials),
    code: authorizationCode,
    grant_type: 'authorization_code',
  });

  const response = await fetchImpl(APPLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const failure = (await response.json().catch(() => ({}))) as AppleTokenErrorBody;
    throw new AppleExchangeError(
      failure.error ?? `http_${response.status}`,
      failure.error_description ?? `Apple rejected the authorization code (${response.status})`,
    );
  }

  const payload = (await response.json()) as AppleTokenSuccessBody;
  if (!payload.refresh_token) {
    // Apple omits it when the code was issued without offline access; there is
    // nothing to store and nothing to revoke later.
    throw new AppleExchangeError('no_refresh_token', 'Apple returned no refresh token');
  }

  return { refreshToken: payload.refresh_token };
}
