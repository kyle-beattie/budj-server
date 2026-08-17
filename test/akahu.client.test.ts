import { describe, expect, it } from 'vitest';
import { AkahuClient, AkahuError } from '../src/modules/bank-connections/akahu.client.js';
import { AKAHU_SCOPES } from '../src/modules/bank-connections/akahu.types.js';

const credentials = {
  appToken: 'app_token_test',
  appSecret: 'app-secret',
  redirectUri: 'https://budj.example/api/bank-connections/callback',
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stubFetch(response: { status?: number; body: unknown }, calls: Call[] = []): typeof fetch {
  return (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const status = response.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => response.body,
    };
  }) as unknown as typeof fetch;
}

describe('createAuthorisationRequest', () => {
  it('asks Akahu to build the URL rather than assembling one', async () => {
    const calls: Call[] = [];
    const client = new AkahuClient(
      credentials,
      stubFetch({ status: 201, body: { success: true, authorisation_url: 'https://oauth.akahu.nz/x' } }, calls),
    );

    const { authorisationUrl } = await client.createAuthorisationRequest('state-1');

    expect(calls[0]?.url).toBe('https://api.akahu.io/v1/par');
    expect(calls[0]?.method).toBe('POST');
    expect(authorisationUrl).toBe('https://oauth.akahu.nz/x');
  });

  /**
   * D7, asserted rather than described.
   *
   * This test is only possible because authorisation goes through a pushed
   * request: with the inline `oauth.akahu.nz` URL the granular scopes come from
   * static app configuration and the `scope` parameter carries only
   * `ENDURING_CONSENT`, so there would be nothing here to check.
   */
  it('requests exactly the five scopes and no others', async () => {
    const calls: Call[] = [];
    const client = new AkahuClient(
      credentials,
      stubFetch({ status: 201, body: { authorisation_url: 'https://oauth.akahu.nz/x' } }, calls),
    );

    await client.createAuthorisationRequest('state-1');

    const scope = (calls[0]?.body as { request: { scope: string[] } }).request.scope;
    expect([...scope].sort()).toEqual([...AKAHU_SCOPES].sort());
  });

  /**
   * The two that must never appear. `payments` would let this change move
   * money, which it explicitly does not; `accounts:balance` would be
   * inconsistent with storing no balances, and widening consent later costs
   * every existing user a trip back through their bank.
   */
  it('never requests payments or account balances', async () => {
    const calls: Call[] = [];
    const client = new AkahuClient(
      credentials,
      stubFetch({ status: 201, body: { authorisation_url: 'https://oauth.akahu.nz/x' } }, calls),
    );

    await client.createAuthorisationRequest('state-1');

    const scope = (calls[0]?.body as { request: { scope: string[] } }).request.scope;
    expect(scope).not.toContain('payments');
    expect(scope).not.toContain('accounts:balance');
  });

  it('asks for enduring access and carries the state', async () => {
    const calls: Call[] = [];
    const client = new AkahuClient(
      credentials,
      stubFetch({ status: 201, body: { authorisation_url: 'https://oauth.akahu.nz/x' } }, calls),
    );

    await client.createAuthorisationRequest('state-abc');

    expect(calls[0]?.body).toMatchObject({
      response_type: 'code',
      state: 'state-abc',
      redirect_uri: credentials.redirectUri,
      request: { type: 'enduring_access' },
    });
  });
});

describe('exchangeCode', () => {
  it('posts the code with app credentials and returns the token', async () => {
    const calls: Call[] = [];
    const client = new AkahuClient(
      credentials,
      stubFetch({ body: { success: true, access_token: 'user_token_1' } }, calls),
    );

    const { accessToken } = await client.exchangeCode('code-1');

    expect(calls[0]?.url).toBe('https://api.akahu.io/v1/token');
    expect(calls[0]?.body).toMatchObject({
      grant_type: 'authorization_code',
      code: 'code-1',
      client_id: credentials.appToken,
      client_secret: credentials.appSecret,
      redirect_uri: credentials.redirectUri,
    });
    expect(accessToken).toBe('user_token_1');
  });

  /** `/token` reports failure in `error`, unlike every other Akahu endpoint. */
  it('surfaces the error field rather than looking for a message', async () => {
    const client = new AkahuClient(
      credentials,
      stubFetch({ status: 400, body: { success: false, error: 'invalid_grant' } }),
    );

    await expect(client.exchangeCode('spent')).rejects.toThrow(/invalid_grant/);
  });

  /** `success: false` with a 200 must not be read as success. */
  it('treats a 200 carrying success:false as a failure', async () => {
    const client = new AkahuClient(
      credentials,
      stubFetch({ status: 200, body: { success: false, error: 'nope' } }),
    );

    await expect(client.exchangeCode('code-1')).rejects.toBeInstanceOf(AkahuError);
  });
});

describe('listAccounts', () => {
  it('sends both the user token and the app id header', async () => {
    const calls: Call[] = [];
    const client = new AkahuClient(credentials, stubFetch({ body: { items: [] } }, calls));

    await client.listAccounts('user_token_1');

    expect(calls[0]?.url).toBe('https://api.akahu.io/v1/accounts');
    expect(calls[0]?.headers).toMatchObject({
      Authorization: 'Bearer user_token_1',
      'X-Akahu-Id': credentials.appToken,
    });
  });

  it('returns the accounts with their nested connection', async () => {
    const client = new AkahuClient(
      credentials,
      stubFetch({
        body: {
          items: [
            {
              _id: 'acc_1',
              name: 'Everyday',
              type: 'CHECKING',
              attributes: ['TRANSACTIONS', 'PAYMENT_FROM', 'PAYMENT_TO'],
              connection: { _id: 'conn_1', name: 'ANZ', logo: 'https://logo' },
            },
          ],
        },
      }),
    );

    const accounts = await client.listAccounts('user_token_1');

    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ _id: 'acc_1', connection: { _id: 'conn_1', name: 'ANZ' } });
  });

  /**
   * A balance must not be able to reach the projection even if Akahu sends
   * one. Zod strips unknown keys, and `balance` is deliberately not modelled.
   */
  it('discards a balance if Akahu returns one', async () => {
    const client = new AkahuClient(
      credentials,
      stubFetch({
        body: {
          items: [
            {
              _id: 'acc_1',
              name: 'Everyday',
              type: 'CHECKING',
              balance: { current: 1234.56, currency: 'NZD' },
              connection: { _id: 'conn_1', name: 'ANZ' },
            },
          ],
        },
      }),
    );

    const [account] = await client.listAccounts('user_token_1');

    expect(account).not.toHaveProperty('balance');
    expect(JSON.stringify(account)).not.toContain('1234.56');
  });

  /** An unrecognised type must survive parsing so the sync can map it later. */
  it('accepts an account type it has never seen', async () => {
    const client = new AkahuClient(
      credentials,
      stubFetch({
        body: {
          items: [
            {
              _id: 'acc_1',
              name: 'Something New',
              type: 'CRYPTO_VAULT',
              connection: { _id: 'conn_1', name: 'ANZ' },
            },
          ],
        },
      }),
    );

    const [account] = await client.listAccounts('user_token_1');

    expect(account?.type).toBe('CRYPTO_VAULT');
  });
});

describe('revokeToken', () => {
  it('deletes the token with both headers', async () => {
    const calls: Call[] = [];
    const client = new AkahuClient(credentials, stubFetch({ body: { success: true } }, calls));

    await client.revokeToken('user_token_1');

    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.url).toBe('https://api.akahu.io/v1/token');
    expect(calls[0]?.headers).toMatchObject({
      Authorization: 'Bearer user_token_1',
      'X-Akahu-Id': credentials.appToken,
    });
  });

  it('throws when Akahu refuses, so the caller can keep the credential', async () => {
    const client = new AkahuClient(
      credentials,
      stubFetch({ status: 401, body: { success: false, message: 'unauthorized' } }),
    );

    await expect(client.revokeToken('user_token_1')).rejects.toBeInstanceOf(AkahuError);
  });
});

describe('getAkahuUserId', () => {
  it('returns the akahu user id', async () => {
    const client = new AkahuClient(
      credentials,
      stubFetch({ body: { success: true, item: { _id: 'user_akahu_1' } } }),
    );

    expect(await client.getAkahuUserId('user_token_1')).toBe('user_akahu_1');
  });

  it('returns null when Akahu omits it', async () => {
    const client = new AkahuClient(credentials, stubFetch({ body: { success: true } }));

    expect(await client.getAkahuUserId('user_token_1')).toBeNull();
  });
});

describe('transport failures', () => {
  it('wraps a network error as a 502 rather than leaking it as a 500', async () => {
    const client = new AkahuClient(credentials, (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch);

    const error = await client.listAccounts('user_token_1').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AkahuError);
    expect((error as AkahuError).statusCode).toBe(502);
  });
});
