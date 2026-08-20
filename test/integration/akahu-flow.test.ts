import { afterAll, beforeAll, expect, it } from 'vitest';
import type { AkahuClient } from '../../src/modules/bank-connections/akahu.client.js';
import type { AkahuAccount } from '../../src/modules/bank-connections/akahu.types.js';
import { AkahuConnectionsRepository } from '../../src/modules/bank-connections/connections.repository.js';
import { BankConnectionsService } from '../../src/modules/bank-connections/bank-connections.service.js';
import { AkahuStateRepository } from '../../src/modules/bank-connections/state.repository.js';
import { AkahuTokenRepository } from '../../src/modules/bank-connections/token.repository.js';
import { PLANS } from '../../src/modules/billing/plans.js';
import {
  anonClient,
  cleanupTestUsers,
  describeIntegration,
  serviceClient,
  signUpTestUser,
  type TestUser,
} from './harness.js';

const silentLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
} as unknown as ConstructorParameters<typeof BankConnectionsService>[4];

function account(overrides: Partial<AkahuAccount> = {}): AkahuAccount {
  return {
    _id: 'acc_1',
    name: 'Everyday',
    type: 'CHECKING',
    attributes: ['TRANSACTIONS', 'PAYMENT_FROM', 'PAYMENT_TO'],
    connection: { _id: 'conn_anz', name: 'ANZ', logo: 'https://logo' },
    ...overrides,
  } as AkahuAccount;
}

interface AkahuStub {
  client: AkahuClient;
  accounts: AkahuAccount[];
  exchanged: string[];
}

function stubAkahu(accounts: AkahuAccount[] = [account()]): AkahuStub {
  const stub: AkahuStub = {
    accounts,
    exchanged: [],
    client: {
      createAuthorisationRequest: async (state: string) => ({
        authorisationUrl: `https://oauth.akahu.nz/?state=${state}`,
      }),
      exchangeCode: async (code: string) => {
        stub.exchanged.push(code);
        return { accessToken: 'user_token_from_akahu' };
      },
      getAkahuUserId: async () => 'akahu_user_1',
      listAccounts: async () => stub.accounts,
    } as unknown as AkahuClient,
  };
  return stub;
}

/**
 * The authorisation flow and the projection, against a real database.
 *
 * Akahu is stubbed — its request shapes are unit-tested. What needs Postgres is
 * the state machinery, the upsert identity rules, and that a disconnected
 * account is marked rather than deleted.
 */
describeIntegration('akahu authorisation flow', () => {
  let user: TestUser;
  let other: TestUser;

  function serviceFor(userClient = user.client, akahu: AkahuClient = stubAkahu().client) {
    return new BankConnectionsService(
      new AkahuConnectionsRepository(userClient),
      new AkahuStateRepository(serviceClient()),
      new AkahuTokenRepository(serviceClient()),
      akahu,
      silentLogger,
    );
  }

  beforeAll(async () => {
    user = await signUpTestUser();
    other = await signUpTestUser();
  });

  afterAll(cleanupTestUsers);

  it('issues an authorisation url', async () => {
    const { authorisationUrl } = await serviceFor().startAuthorisation(user.id, PLANS.standard);

    expect(authorisationUrl).toContain('https://oauth.akahu.nz/');
  });

  /** A state is a capability: whoever holds it can complete a connection. */
  it('keeps authorisation state invisible to every user client', async () => {
    await serviceFor().startAuthorisation(user.id, PLANS.standard);

    const { data: asOwner } = await user.client.from('akahu_auth_states').select('state');
    const { data: asAnon } = await anonClient().from('akahu_auth_states').select('state');

    expect(asOwner ?? []).toEqual([]);
    expect(asAnon ?? []).toEqual([]);
  });

  /**
   * There is one plan now, so this names its own limit rather than reaching for
   * whichever tier happened to be small. The subject is the guardrail, not the
   * catalogue — and inserting ten rows to exercise the real number would be
   * testing the number instead of the check.
   */
  it('refuses a connection beyond the plan limit', async () => {
    const admin = serviceClient();
    for (const id of ['conn_a', 'conn_b']) {
      await admin.from('akahu_connections').insert({
        user_id: other.id,
        connection_id: id,
        name: id,
      });
    }

    await expect(
      new BankConnectionsService(
        new AkahuConnectionsRepository(other.client),
        new AkahuStateRepository(serviceClient()),
        new AkahuTokenRepository(serviceClient()),
        stubAkahu().client,
        silentLogger,
      ).startAuthorisation(other.id, { ...PLANS.standard, maxConnections: 2 }),
    ).rejects.toMatchObject({ code: 'PLAN_LIMIT_EXCEEDED' });
  });

  describe_stateRules();
  describe_projection();

  function describe_stateRules(): void {
    it('completes the flow and stores an encrypted token', async () => {
      const akahu = stubAkahu();
      const service = serviceFor(user.client, akahu.client);

      const state = await extractState(await service.startAuthorisation(user.id, PLANS.standard));
      const result = await service.completeAuthorisation(user.id, { code: 'code-1', state });

      expect(akahu.exchanged).toEqual(['code-1']);
      expect(result).toEqual({ connections: 1, accounts: 1 });

      const stored = await new AkahuTokenRepository(serviceClient()).getAkahuToken(user.id);
      expect(stored).toBe('user_token_from_akahu');

      const { data } = await serviceClient()
        .from('akahu_tokens')
        .select('token_ciphertext')
        .eq('user_id', user.id)
        .single();
      expect(data!.token_ciphertext).not.toContain('user_token_from_akahu');
    });

    /** A replayed redirect must not connect a bank twice. */
    it('refuses a reused state', async () => {
      const service = serviceFor();
      const state = await extractState(await service.startAuthorisation(user.id, PLANS.standard));

      await service.completeAuthorisation(user.id, { code: 'code-1', state });

      await expect(
        service.completeAuthorisation(user.id, { code: 'code-2', state }),
      ).rejects.toThrow(/invalid, expired, or already used/);
    });

    it('refuses an unknown state', async () => {
      await expect(
        serviceFor().completeAuthorisation(user.id, { code: 'code-1', state: 'never-issued' }),
      ).rejects.toThrow(/invalid, expired, or already used/);
    });

    /**
     * The attack the state binding exists to stop: someone else's authorisation
     * completing against your account.
     */
    it('refuses a state issued to a different user', async () => {
      const service = serviceFor();
      const state = await extractState(await service.startAuthorisation(user.id, PLANS.standard));

      await expect(
        service.completeAuthorisation(other.id, { code: 'code-1', state }),
      ).rejects.toThrow(/invalid, expired, or already used/);
    });

    it('does not exchange the code when the state is refused', async () => {
      const akahu = stubAkahu();

      await serviceFor(user.client, akahu.client)
        .completeAuthorisation(user.id, { code: 'code-1', state: 'never-issued' })
        .catch(() => undefined);

      // State first: a bad state must not burn a one-shot code.
      expect(akahu.exchanged).toEqual([]);
    });

    it('refuses an expired state', async () => {
      const states = new AkahuStateRepository(serviceClient());
      const state = await states.issue(user.id, new Date(Date.now() - 60 * 60 * 1000));

      expect(await states.consume(state)).toBeNull();
    });
  }

  function describe_projection(): void {
    it('projects accounts with both payment directions', async () => {
      const fresh = await signUpTestUser();
      const akahu = stubAkahu([
        account({ _id: 'acc_cheque', attributes: ['PAYMENT_FROM', 'PAYMENT_TO'] }),
        account({ _id: 'acc_card', type: 'CREDITCARD', attributes: ['PAYMENT_FROM'] }),
      ]);
      const service = serviceFor(fresh.client, akahu.client);

      const state = await extractState(await service.startAuthorisation(fresh.id, PLANS.standard));
      await service.completeAuthorisation(fresh.id, { code: 'c', state });

      const { data } = await serviceClient()
        .from('accounts')
        .select('akahu_account_id, type, payment_from, payment_to')
        .eq('user_id', fresh.id)
        .order('akahu_account_id');

      expect(data).toMatchObject([
        { akahu_account_id: 'acc_card', type: 'credit_card', payment_from: true, payment_to: false },
        { akahu_account_id: 'acc_cheque', type: 'checking', payment_from: true, payment_to: true },
      ]);
    });

    it('stores duplicate names as separate accounts', async () => {
      const fresh = await signUpTestUser();
      const akahu = stubAkahu([
        account({ _id: 'acc_1', name: 'Savings' }),
        account({ _id: 'acc_2', name: 'Savings' }),
      ]);
      const service = serviceFor(fresh.client, akahu.client);

      const state = await extractState(await service.startAuthorisation(fresh.id, PLANS.standard));
      const result = await service.completeAuthorisation(fresh.id, { code: 'c', state });

      expect(result.accounts).toBe(2);
    });

    it('marks an account absent from a later sync as disconnected, not deleted', async () => {
      const fresh = await signUpTestUser();
      const akahu = stubAkahu([account({ _id: 'acc_1' }), account({ _id: 'acc_2' })]);
      const service = serviceFor(fresh.client, akahu.client);

      const state = await extractState(await service.startAuthorisation(fresh.id, PLANS.standard));
      await service.completeAuthorisation(fresh.id, { code: 'c', state });

      // Akahu stops reporting the second account.
      akahu.accounts = [account({ _id: 'acc_1' })];
      await service.resync(fresh.id);

      const { data } = await serviceClient()
        .from('accounts')
        .select('akahu_account_id, disconnected_at')
        .eq('user_id', fresh.id)
        .order('akahu_account_id');

      expect(data).toHaveLength(2);
      expect(data?.[0]?.disconnected_at).toBeNull();
      expect(data?.[1]?.disconnected_at).not.toBeNull();
    });

    it('reconnects an account that reappears', async () => {
      const fresh = await signUpTestUser();
      const akahu = stubAkahu([account({ _id: 'acc_1' }), account({ _id: 'acc_2' })]);
      const service = serviceFor(fresh.client, akahu.client);

      const state = await extractState(await service.startAuthorisation(fresh.id, PLANS.standard));
      await service.completeAuthorisation(fresh.id, { code: 'c', state });

      akahu.accounts = [account({ _id: 'acc_1' })];
      await service.resync(fresh.id);
      akahu.accounts = [account({ _id: 'acc_1' }), account({ _id: 'acc_2' })];
      await service.resync(fresh.id);

      const { data } = await serviceClient()
        .from('accounts')
        .select('disconnected_at')
        .eq('user_id', fresh.id);

      expect(data?.every((row) => row.disconnected_at === null)).toBe(true);
    });

    it('disconnects a connection and its accounts without deleting them', async () => {
      const fresh = await signUpTestUser();
      const akahu = stubAkahu();
      const service = serviceFor(fresh.client, akahu.client);

      const state = await extractState(await service.startAuthorisation(fresh.id, PLANS.standard));
      await service.completeAuthorisation(fresh.id, { code: 'c', state });

      const connections = await service.list(fresh.id, false);
      await service.revokeConnection(fresh.id, connections[0]!.id);

      const { data: accounts } = await serviceClient()
        .from('accounts')
        .select('disconnected_at')
        .eq('user_id', fresh.id);

      expect(accounts).toHaveLength(1);
      expect(accounts?.[0]?.disconnected_at).not.toBeNull();
      expect(await service.list(fresh.id, false)).toEqual([]);
      expect(await service.list(fresh.id, true)).toHaveLength(1);
    });

    it('refuses to disconnect a connection belonging to someone else', async () => {
      const owner = await signUpTestUser();
      const akahu = stubAkahu();
      const ownerService = serviceFor(owner.client, akahu.client);

      const state = await extractState(await ownerService.startAuthorisation(owner.id, PLANS.standard));
      await ownerService.completeAuthorisation(owner.id, { code: 'c', state });
      const [connection] = await ownerService.list(owner.id, false);

      await expect(
        serviceFor(user.client, akahu.client).revokeConnection(user.id, connection!.id),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  }

  async function extractState({ authorisationUrl }: { authorisationUrl: string }): Promise<string> {
    return new URL(authorisationUrl).searchParams.get('state')!;
  }
});
