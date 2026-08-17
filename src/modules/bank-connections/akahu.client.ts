import { AppError } from '../../lib/errors.js';
import {
  AKAHU_SCOPES,
  akahuAccountsResponseSchema,
  akahuMeResponseSchema,
  akahuParResponseSchema,
  akahuTokenResponseSchema,
  type AkahuAccount,
} from './akahu.types.js';

/**
 * The Akahu API, narrowed to what onboarding needs.
 *
 * The iOS app never holds an Akahu token and never calls Akahu — this server is
 * always in the middle. Every method here takes the credential explicitly
 * rather than reaching for it, so a caller cannot accidentally act with the
 * wrong user's token.
 *
 * ## Two different authentications, easy to confuse
 *
 * - **App credentials** (`client_id` + `client_secret` in the body, or Basic
 *   auth) identify *us* to Akahu. Used to start an authorisation and to
 *   exchange a code.
 * - **User token** (`Authorization: Bearer user_token_...`) plus
 *   `X-Akahu-Id: <app token>` reads a *person's* data. Both headers are
 *   required together; the bearer token alone is rejected.
 */

const AKAHU_API_BASE = 'https://api.akahu.io/v1';
const REQUEST_TIMEOUT_MS = 15_000;

export interface AkahuCredentials {
  appToken: string;
  appSecret: string;
  redirectUri: string;
}

export class AkahuError extends AppError {
  constructor(message: string, options: { statusCode?: number; cause?: unknown } = {}) {
    super(message, {
      // Akahu being unavailable is not the caller's fault.
      statusCode: options.statusCode ?? 502,
      code: 'AKAHU_ERROR',
      cause: options.cause,
    });
  }
}

async function akahuFetch(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  description: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (cause) {
    throw new AkahuError(`Akahu request failed (${description})`, { cause });
  }

  const body = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    error?: string;
    message?: string;
  };

  if (!response.ok || body.success === false) {
    // `/token` reports failure in `error`; every other endpoint uses `message`.
    const reason = body.error ?? body.message ?? `HTTP ${response.status}`;
    throw new AkahuError(`Akahu rejected the request (${description}): ${reason}`, {
      statusCode: response.status === 401 || response.status === 403 ? 502 : undefined,
    });
  }

  return body;
}

export class AkahuClient {
  constructor(
    private readonly credentials: AkahuCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * Start authorisation via a **pushed authorisation request**, and let Akahu
   * build the URL.
   *
   * The alternative — assembling an `oauth.akahu.nz` URL by hand — cannot
   * satisfy D7. With that method the granular scopes come from static app
   * configuration in Akahu's dashboard and the `scope` parameter carries only
   * `ENDURING_CONSENT`, so "the request asks for exactly these five scopes" is
   * neither true nor assertable. Here the scope array is in the request body,
   * which is why the test in this module can be written at all.
   */
  async createAuthorisationRequest(state: string): Promise<{ authorisationUrl: string }> {
    const body = await akahuFetch(
      `${AKAHU_API_BASE}/par`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: this.credentials.appToken,
          client_secret: this.credentials.appSecret,
          redirect_uri: this.credentials.redirectUri,
          response_type: 'code',
          state,
          request: {
            type: 'enduring_access',
            scope: [...AKAHU_SCOPES],
          },
        }),
      },
      this.fetchImpl,
      'create authorisation request',
    );

    const parsed = akahuParResponseSchema.parse(body);
    return { authorisationUrl: parsed.authorisation_url };
  }

  /**
   * Exchange the authorisation code for a user access token.
   *
   * **Akahu allows 60 seconds.** There is no retry to build: a slow redirect
   * handler is a failed connection, and the user has to start again.
   */
  async exchangeCode(code: string): Promise<{ accessToken: string }> {
    const body = await akahuFetch(
      `${AKAHU_API_BASE}/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          redirect_uri: this.credentials.redirectUri,
          client_id: this.credentials.appToken,
          client_secret: this.credentials.appSecret,
        }),
      },
      this.fetchImpl,
      'exchange authorisation code',
    );

    return { accessToken: akahuTokenResponseSchema.parse(body).access_token };
  }

  /**
   * Every account the user has connected, across all their institutions.
   *
   * Each account carries its own nested `connection`, so this is also where the
   * user's connections come from. `GET /v1/connections` is **not** that — it is
   * the catalogue of institutions Akahu supports, authenticated with app
   * credentials, and it says nothing about a particular person.
   */
  async listAccounts(userToken: string): Promise<AkahuAccount[]> {
    const body = await akahuFetch(
      `${AKAHU_API_BASE}/accounts`,
      { method: 'GET', headers: this.userHeaders(userToken) },
      this.fetchImpl,
      'list accounts',
    );

    return akahuAccountsResponseSchema.parse(body).items;
  }

  /** The Akahu user id — the reverse-lookup key a transaction webhook needs. */
  async getAkahuUserId(userToken: string): Promise<string | null> {
    const body = await akahuFetch(
      `${AKAHU_API_BASE}/me`,
      { method: 'GET', headers: this.userHeaders(userToken) },
      this.fetchImpl,
      'identify user',
    );

    return akahuMeResponseSchema.parse(body).item?._id ?? null;
  }

  /**
   * Revoke the user's token with Akahu.
   *
   * This removes **all** of our access to that person's data and stops Akahu
   * billing for them. It is the call D9 exists for, and it must happen before
   * the stored ciphertext is deleted — afterwards there is nothing left to
   * revoke with.
   */
  async revokeToken(userToken: string): Promise<void> {
    await akahuFetch(
      `${AKAHU_API_BASE}/token`,
      { method: 'DELETE', headers: this.userHeaders(userToken) },
      this.fetchImpl,
      'revoke user token',
    );
  }

  /** Both headers are required together for any user-scoped read. */
  private userHeaders(userToken: string): Record<string, string> {
    return {
      Authorization: `Bearer ${userToken}`,
      'X-Akahu-Id': this.credentials.appToken,
    };
  }
}
