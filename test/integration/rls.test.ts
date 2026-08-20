import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  anonClient,
  cleanupTestUsers,
  describeIntegration,
  serviceClient,
  signUpTestUser,
  type TestUser,
} from './harness.js';

/**
 * The first real proof that the RLS policies work.
 *
 * `CLAUDE.md` describes tenancy as enforced twice — by the repository's
 * `.eq('user_id', …)` and by the database's policies — and calls the redundancy
 * deliberate. Until this file ran, only the first half had ever been executed.
 * These tests assert the database's half in isolation, going straight to
 * PostgREST with no repository in the way.
 */
describeIntegration('row level security', () => {
  let alice: TestUser;
  let bob: TestUser;
  let bobConnectionId: string;
  let bobAccountId: string;

  beforeAll(async () => {
    alice = await signUpTestUser();
    bob = await signUpTestUser();

    const admin = serviceClient();

    const { data: connection, error: connectionError } = await admin
      .from('akahu_connections')
      .insert({ user_id: bob.id, connection_id: 'conn_bob_anz', name: 'ANZ' })
      .select('id')
      .single();
    if (connectionError) throw new Error(`fixture failed: ${connectionError.message}`);
    bobConnectionId = connection.id;

    const { data: account, error: accountError } = await admin
      .from('accounts')
      .insert({
        user_id: bob.id,
        connection_id: bobConnectionId,
        akahu_account_id: 'acc_bob_everyday',
        name: 'Everyday',
        type: 'checking',
      })
      .select('id')
      .single();
    if (accountError) throw new Error(`fixture failed: ${accountError.message}`);
    bobAccountId = account.id;
  });

  afterAll(cleanupTestUsers);

  it('lets a user read their own account', async () => {
    const { data, error } = await bob.client.from('accounts').select('id').eq('id', bobAccountId);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("hides another user's account, even when asked for by id", async () => {
    const { data, error } = await alice.client.from('accounts').select('id').eq('id', bobAccountId);

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("hides another user's bank connection", async () => {
    const { data } = await alice.client
      .from('akahu_connections')
      .select('id')
      .eq('id', bobConnectionId);

    expect(data).toEqual([]);
  });

  it('refuses to let a user insert an account owned by someone else', async () => {
    const { error } = await alice.client.from('accounts').insert({
      user_id: bob.id,
      connection_id: bobConnectionId,
      akahu_account_id: 'acc_forged',
      name: 'Forged',
      type: 'checking',
    });

    // 42501 is the RLS rejection the error mapper turns into a 404.
    expect(error?.code).toBe('42501');
  });

  it('shows an anonymous caller nothing at all', async () => {
    const { data } = await anonClient().from('accounts').select('id');

    expect(data ?? []).toEqual([]);
  });

  /**
   * The load-bearing assertion of the whole token custody design (D4).
   *
   * `akahu_tokens` has RLS enabled and no policies, so PostgREST denies by
   * default. If this test ever fails, a leaked user JWT reads a bearer
   * credential for someone's bank.
   */
  it('hides akahu_tokens from the user client entirely', async () => {
    const admin = serviceClient();
    const { error: seedError } = await admin
      .from('akahu_tokens')
      .insert({ user_id: bob.id, akahu_user_id: 'user_bob', token_ciphertext: 'v1:ciphertext' });
    expect(seedError).toBeNull();

    // The row exists — the service role can see it.
    const { data: asService } = await admin
      .from('akahu_tokens')
      .select('user_id')
      .eq('user_id', bob.id);
    expect(asService).toHaveLength(1);

    // Its own owner cannot.
    const { data: asOwner } = await bob.client.from('akahu_tokens').select('user_id');
    expect(asOwner ?? []).toEqual([]);

    const { data: asStranger } = await alice.client.from('akahu_tokens').select('user_id');
    expect(asStranger ?? []).toEqual([]);

    const { data: asAnon } = await anonClient().from('akahu_tokens').select('user_id');
    expect(asAnon ?? []).toEqual([]);
  });

  it('hides apple_grants from the user client entirely', async () => {
    const { error: seedError } = await serviceClient()
      .from('apple_grants')
      .insert({ user_id: bob.id, refresh_token_ciphertext: 'v1:ciphertext' });
    expect(seedError).toBeNull();

    const { data: asOwner } = await bob.client.from('apple_grants').select('user_id');
    expect(asOwner ?? []).toEqual([]);
  });

  it('lets a user read their subscription but never write one', async () => {
    const { error: seedError } = await serviceClient().from('billing_subscriptions').insert({
      user_id: bob.id,
      original_transaction_id: 'txn_bob_1',
      product_id: 'com.budj.standard.yearly',
      plan_code: 'standard',
      status: 'active',
    });
    expect(seedError).toBeNull();

    const { data: readable } = await bob.client
      .from('billing_subscriptions')
      .select('plan_code, status');
    expect(readable).toHaveLength(1);
    expect(readable?.[0]?.plan_code).toBe('standard');

    // Select-only: a user who could insert here would grant themselves a plan.
    const { error: writeError } = await alice.client.from('billing_subscriptions').insert({
      user_id: alice.id,
      original_transaction_id: 'txn_alice_forged',
      product_id: 'com.budj.standard.yearly',
      plan_code: 'standard',
      status: 'active',
    });
    expect(writeError?.code).toBe('42501');
  });

  /**
   * One Apple subscription must not entitle two accounts. Without the unique
   * constraint on `original_transaction_id`, subscription sharing is a one-line
   * exploit (D8).
   */
  it('refuses to bind one App Store transaction to two users', async () => {
    const { error } = await serviceClient().from('billing_subscriptions').insert({
      user_id: alice.id,
      original_transaction_id: 'txn_bob_1',
      product_id: 'com.budj.standard.yearly',
      plan_code: 'standard',
      status: 'active',
    });

    expect(error?.code).toBe('23505');
  });

  it('refuses two accounts with the same Akahu id for one user', async () => {
    const { error } = await serviceClient().from('accounts').insert({
      user_id: bob.id,
      connection_id: bobConnectionId,
      akahu_account_id: 'acc_bob_everyday',
      name: 'Everyday (duplicate)',
      type: 'checking',
    });

    expect(error?.code).toBe('23505');
  });

  /**
   * Akahu legitimately reports two accounts with the same name, which the old
   * unique index on (user_id, lower(name)) would have rejected mid-sync.
   */
  it('allows two accounts with the same name', async () => {
    const { error } = await serviceClient().from('accounts').insert({
      user_id: bob.id,
      connection_id: bobConnectionId,
      akahu_account_id: 'acc_bob_everyday_2',
      name: 'Everyday',
      type: 'checking',
    });

    expect(error).toBeNull();
  });
});
