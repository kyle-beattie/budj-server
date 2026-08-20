import { afterAll, beforeAll, expect, it } from 'vitest';
import type { AkahuClient } from '../../src/modules/bank-connections/akahu.client.js';
import { AkahuBankAccessRevoker } from '../../src/modules/bank-connections/akahu-revoker.js';
import { AkahuTokenRepository } from '../../src/modules/bank-connections/token.repository.js';
import { BillingRepository } from '../../src/modules/billing/billing.repository.js';
import {
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
} as unknown as ConstructorParameters<typeof AkahuBankAccessRevoker>[2];

/** Records what would have been revoked with Akahu, without calling it. */
function stubAkahu(): { client: AkahuClient; revoked: string[]; fail?: boolean } {
  const revoked: string[] = [];
  const stub = {
    revoked,
    client: {
      revokeToken: async (userToken: string) => {
        if (stub.fail) throw new Error('Akahu is down');
        revoked.push(userToken);
      },
    } as unknown as AkahuClient,
  } as { client: AkahuClient; revoked: string[]; fail?: boolean };
  return stub;
}

function revokerFor(akahu: AkahuClient) {
  return new AkahuBankAccessRevoker(serviceClient(), akahu, silentLogger);
}

/**
 * Entitlement storage and the revocation path, against a real database.
 *
 * The state machine is unit-tested; what needs Postgres is the unique
 * constraint, the select-only policy, and that revocation actually touches
 * every row it claims to.
 */
describeIntegration('billing entitlement', () => {
  let alice: TestUser;
  let bob: TestUser;
  let repository: BillingRepository;

  beforeAll(async () => {
    alice = await signUpTestUser();
    bob = await signUpTestUser();
    repository = new BillingRepository(serviceClient());
  });

  afterAll(cleanupTestUsers);

  it('records and reads back an entitlement', async () => {
    await repository.upsert({
      userId: alice.id,
      originalTransactionId: 'otx-alice',
      productId: 'com.budj.standard.yearly',
      planCode: 'standard',
      status: 'active',
      expiresAt: '2026-09-17T00:00:00.000Z',
      notificationUuid: 'uuid-1',
      notificationAt: '2026-08-17T10:00:00.000Z',
    });

    const row = await repository.findByUserId(alice.id);
    expect(row).toMatchObject({ plan_code: 'standard', status: 'active' });
  });

  /** The join a notification uses: Apple knows nothing about our users. */
  it('finds an entitlement by Apple’s original transaction id', async () => {
    const row = await repository.findByOriginalTransactionId('otx-alice');
    expect(row?.user_id).toBe(alice.id);
  });

  it('updates in place rather than accumulating rows', async () => {
    await repository.upsert({
      userId: alice.id,
      originalTransactionId: 'otx-alice',
      productId: 'com.budj.standard.yearly',
      planCode: 'standard',
      status: 'expired',
      expiresAt: '2026-09-17T00:00:00.000Z',
      notificationUuid: 'uuid-2',
      notificationAt: '2026-08-17T11:00:00.000Z',
    });

    const { count } = await serviceClient()
      .from('billing_subscriptions')
      .select('user_id', { count: 'exact' })
      .eq('user_id', alice.id);

    expect(count).toBe(1);
    expect((await repository.findByUserId(alice.id))?.status).toBe('expired');
  });

  /**
   * Without this constraint, subscription sharing is a one-line exploit: two
   * accounts both pointing at one App Store purchase.
   */
  it('refuses to bind one App Store subscription to a second account', async () => {
    await expect(
      repository.upsert({
        userId: bob.id,
        originalTransactionId: 'otx-alice',
        productId: 'com.budj.standard.yearly',
        planCode: 'standard',
        status: 'active',
        expiresAt: null,
        notificationUuid: 'uuid-3',
        notificationAt: null,
      }),
    ).rejects.toThrow(/already linked to another account/);

    // Alice keeps hers, unchanged.
    expect((await repository.findByUserId(alice.id))?.user_id).toBe(alice.id);
  });

  it('lets a user read their own entitlement but never write one', async () => {
    const { data } = await alice.client.from('billing_subscriptions').select('plan_code');
    expect(data).toHaveLength(1);

    const { error } = await alice.client
      .from('billing_subscriptions')
      .update({ plan_code: 'standard', status: 'active' })
      .eq('user_id', alice.id);

    // Select-only: no update policy, so nothing is written.
    expect(await forbiddenOrNoOp(error, alice.id)).toBe(true);
  });

  describe_revocation();

  async function forbiddenOrNoOp(error: unknown, userId: string): Promise<boolean> {
    // PostgREST either errors (42501) or silently matches zero rows, depending
    // on whether the policy or the grant refuses first. Either is acceptable —
    // what matters is that the row did not change.
    const row = await repository.findByUserId(userId);
    return Boolean(error) || row?.status === 'expired';
  }
});

/** Grouped separately so the fixtures above stay readable. */
function describe_revocation(): void {
  it('marks every connection and account disconnected when entitlement ends', async () => {
    const user = await signUpTestUser();
    const admin = serviceClient();

    const { data: connection } = await admin
      .from('akahu_connections')
      .insert({ user_id: user.id, connection_id: 'conn_revoke', name: 'ANZ' })
      .select('id')
      .single();

    await admin.from('accounts').insert({
      user_id: user.id,
      connection_id: connection!.id,
      akahu_account_id: 'acc_revoke',
      name: 'Everyday',
      type: 'checking',
    });

    await revokerFor(stubAkahu().client).revoke(user.id);

    const { data: connections } = await admin
      .from('akahu_connections')
      .select('disconnected_at')
      .eq('user_id', user.id);
    const { data: accounts } = await admin
      .from('accounts')
      .select('disconnected_at')
      .eq('user_id', user.id);

    expect(connections?.every((row) => row.disconnected_at !== null)).toBe(true);
    expect(accounts?.every((row) => row.disconnected_at !== null)).toBe(true);
  });

  /** Two entitlement-ending notifications in a row must not be an error. */
  it('is idempotent', async () => {
    const user = await signUpTestUser();
    const admin = serviceClient();
    const revoker = revokerFor(stubAkahu().client);

    await admin
      .from('akahu_connections')
      .insert({ user_id: user.id, connection_id: 'conn_twice', name: 'ASB' });

    await revoker.revoke(user.id);
    const first = await admin
      .from('akahu_connections')
      .select('disconnected_at')
      .eq('user_id', user.id)
      .single();

    await expect(revoker.revoke(user.id)).resolves.toBeUndefined();

    const second = await admin
      .from('akahu_connections')
      .select('disconnected_at')
      .eq('user_id', user.id)
      .single();

    // The second pass leaves the original timestamp alone.
    expect(second.data?.disconnected_at).toBe(first.data?.disconnected_at);
  });

  it('revokes a user with nothing connected without complaint', async () => {
    const user = await signUpTestUser();

    await expect(revokerFor(stubAkahu().client).revoke(user.id)).resolves.toBeUndefined();
  });
}
