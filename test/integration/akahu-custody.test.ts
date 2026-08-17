import { afterAll, beforeAll, expect, it } from 'vitest';
import { config } from '../../src/config/index.js';
import type { AkahuClient } from '../../src/modules/bank-connections/akahu.client.js';
import { AkahuBankAccessRevoker } from '../../src/modules/bank-connections/akahu-revoker.js';
import { AkahuTokenRepository } from '../../src/modules/bank-connections/token.repository.js';
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
} as unknown as ConstructorParameters<typeof AkahuBankAccessRevoker>[2];

interface AkahuStub {
  client: AkahuClient;
  revokedWith: string[];
  fail: boolean;
}

function stubAkahu(): AkahuStub {
  const stub: AkahuStub = {
    revokedWith: [],
    fail: false,
    client: {
      revokeToken: async (userToken: string) => {
        if (stub.fail) throw new Error('Akahu unavailable');
        stub.revokedWith.push(userToken);
      },
    } as unknown as AkahuClient,
  };
  return stub;
}

/**
 * Custody of the Akahu token, and the ordering of the revocation path.
 *
 * Akahu itself is stubbed — what needs a real database is that the credential
 * is unreadable, that it round-trips through encryption, and that it survives
 * an Akahu outage so a retry is still possible.
 */
describeIntegration('akahu token custody', () => {
  let user: TestUser;
  let stranger: TestUser;
  let tokens: AkahuTokenRepository;

  beforeAll(async () => {
    user = await signUpTestUser();
    stranger = await signUpTestUser();
    tokens = new AkahuTokenRepository(serviceClient());
  });

  afterAll(cleanupTestUsers);

  it('round trips a token through encryption', async () => {
    await tokens.store(user.id, 'user_token_abc123', 'akahu_user_1');

    expect(await tokens.getAkahuToken(user.id)).toBe('user_token_abc123');
    expect(await tokens.hasToken(user.id)).toBe(true);
  });

  /** A database dump alone must not yield bank access for every user. */
  it('stores ciphertext, never the token', async () => {
    const { data } = await serviceClient()
      .from('akahu_tokens')
      .select('token_ciphertext')
      .eq('user_id', user.id)
      .single();

    const stored = data!.token_ciphertext;
    expect(stored).not.toContain('user_token_abc123');
    expect(stored.startsWith(`${config.tokenCrypto.keyring.activeVersion}:`)).toBe(true);
  });

  /**
   * The load-bearing assertion of the whole custody design. If this fails, a
   * leaked user JWT reads a bearer credential for someone's bank.
   */
  it('is invisible to every client except the service role', async () => {
    const { data: asOwner } = await user.client.from('akahu_tokens').select('user_id');
    const { data: asStranger } = await stranger.client.from('akahu_tokens').select('user_id');
    const { data: asAnon } = await anonClient().from('akahu_tokens').select('user_id');

    expect(asOwner ?? []).toEqual([]);
    expect(asStranger ?? []).toEqual([]);
    expect(asAnon ?? []).toEqual([]);

    // ...while the row demonstrably exists.
    expect(await tokens.hasToken(user.id)).toBe(true);
  });

  it('reports no token for a user who has never connected', async () => {
    expect(await tokens.getAkahuToken(stranger.id)).toBeNull();
    expect(await tokens.hasToken(stranger.id)).toBe(false);
  });

  it('replaces rather than duplicates when a user reconnects', async () => {
    await tokens.store(user.id, 'user_token_second', 'akahu_user_1');

    const { count } = await serviceClient()
      .from('akahu_tokens')
      .select('user_id', { count: 'exact' })
      .eq('user_id', user.id);

    expect(count).toBe(1);
    expect(await tokens.getAkahuToken(user.id)).toBe('user_token_second');
  });
});

describeIntegration('akahu revocation ordering', () => {
  afterAll(cleanupTestUsers);

  async function connectedUser(): Promise<TestUser> {
    const user = await signUpTestUser();
    const admin = serviceClient();

    await new AkahuTokenRepository(admin).store(user.id, `user_token_${user.id}`, 'akahu_user');
    const { data: connection } = await admin
      .from('akahu_connections')
      .insert({ user_id: user.id, connection_id: 'conn_x', name: 'ANZ' })
      .select('id')
      .single();
    await admin.from('accounts').insert({
      user_id: user.id,
      connection_id: connection!.id,
      akahu_account_id: 'acc_x',
      name: 'Everyday',
      type: 'checking',
    });

    return user;
  }

  it('revokes with Akahu before forgetting the credential', async () => {
    const user = await connectedUser();
    const akahu = stubAkahu();

    await new AkahuBankAccessRevoker(serviceClient(), akahu.client, silentLogger).revoke(user.id);

    // Akahu was told, using the real decrypted token...
    expect(akahu.revokedWith).toEqual([`user_token_${user.id}`]);
    // ...and only then was the credential discarded.
    expect(await new AkahuTokenRepository(serviceClient()).hasToken(user.id)).toBe(false);
  });

  it('marks connections and accounts disconnected', async () => {
    const user = await connectedUser();

    await new AkahuBankAccessRevoker(serviceClient(), stubAkahu().client, silentLogger).revoke(
      user.id,
    );

    const admin = serviceClient();
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

  /**
   * The failure mode this ordering exists to prevent. If the credential were
   * deleted first, an Akahu outage would leave the connection live and billable
   * with nothing left to revoke it with — permanently.
   */
  it('keeps the credential when Akahu fails, so a retry is still possible', async () => {
    const user = await connectedUser();
    const akahu = stubAkahu();
    akahu.fail = true;

    await new AkahuBankAccessRevoker(serviceClient(), akahu.client, silentLogger).revoke(user.id);

    expect(await new AkahuTokenRepository(serviceClient()).hasToken(user.id)).toBe(true);
  });

  /**
   * ...but the local state still moves. Akahu being down must not leave a
   * refunded user looking connected to us.
   */
  it('still disconnects locally when Akahu fails', async () => {
    const user = await connectedUser();
    const akahu = stubAkahu();
    akahu.fail = true;

    await new AkahuBankAccessRevoker(serviceClient(), akahu.client, silentLogger).revoke(user.id);

    const { data } = await serviceClient()
      .from('akahu_connections')
      .select('disconnected_at')
      .eq('user_id', user.id);

    expect(data?.every((row) => row.disconnected_at !== null)).toBe(true);
  });

  it('is a no-op for a user who never connected a bank', async () => {
    const user = await signUpTestUser();
    const akahu = stubAkahu();

    await expect(
      new AkahuBankAccessRevoker(serviceClient(), akahu.client, silentLogger).revoke(user.id),
    ).resolves.toBeUndefined();

    expect(akahu.revokedWith).toEqual([]);
  });
});
