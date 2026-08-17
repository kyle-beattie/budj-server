import { afterAll, beforeAll, expect, it } from 'vitest';
import { config } from '../../src/config/index.js';
import { decryptToken, encryptToken } from '../../src/lib/token-crypto.js';
import { AppleGrantRepository } from '../../src/modules/auth/apple.repository.js';
import {
  anonClient,
  cleanupTestUsers,
  describeIntegration,
  serviceClient,
  signUpTestUser,
  type TestUser,
} from './harness.js';

/**
 * Custody of Apple's refresh token, proven against a real database.
 *
 * Apple never gets called here — the exchange is unit-tested with a stubbed
 * fetch in `test/apple.client.test.ts`. What needs a database is everything
 * after it: that the credential is unreadable, unrecognisable, and singular.
 */
describeIntegration('apple grant custody', () => {
  let user: TestUser;
  let stranger: TestUser;
  let repository: AppleGrantRepository;

  const keyring = config.tokenCrypto.keyring;

  beforeAll(async () => {
    user = await signUpTestUser();
    stranger = await signUpTestUser();
    repository = new AppleGrantRepository(serviceClient());
  });

  afterAll(cleanupTestUsers);

  it('reports no grant before one is captured', async () => {
    expect(await repository.exists(user.id)).toBe(false);
  });

  it('stores the refresh token as recoverable ciphertext', async () => {
    await repository.upsert(user.id, encrypt('apple-refresh-one'));

    const { data } = await serviceClient()
      .from('apple_grants')
      .select('refresh_token_ciphertext')
      .eq('user_id', user.id)
      .single();

    const stored = data!.refresh_token_ciphertext;
    expect(stored).not.toContain('apple-refresh-one');
    expect(stored.startsWith(`${keyring.activeVersion}:`)).toBe(true);
    expect(decryptToken(keyring, stored)).toBe('apple-refresh-one');
  });

  /**
   * The custody assertion. `apple_grants` has RLS enabled with no policies and
   * is withheld from `authenticated` in the grants block, so the row is
   * invisible to every client except the service role — including its owner's.
   */
  it('hides the grant from every user client, including its owner', async () => {
    const { data: asOwner } = await user.client.from('apple_grants').select('user_id');
    expect(asOwner ?? []).toEqual([]);

    const { data: asStranger } = await stranger.client.from('apple_grants').select('user_id');
    expect(asStranger ?? []).toEqual([]);

    const { data: asAnon } = await anonClient().from('apple_grants').select('user_id');
    expect(asAnon ?? []).toEqual([]);

    // ...while the row demonstrably exists.
    expect(await repository.exists(user.id)).toBe(true);
  });

  it('refuses a write from the owner’s own client', async () => {
    const { error } = await user.client
      .from('apple_grants')
      .insert({ user_id: user.id, refresh_token_ciphertext: 'forged' });

    expect(error).not.toBeNull();
  });

  /**
   * Re-authorising replaces the token rather than accumulating rows: only the
   * newest refresh token is useful, and a second row would make "which one do
   * we revoke with" ambiguous at deletion.
   */
  it('replaces rather than duplicates when a user authorises again', async () => {
    await repository.upsert(user.id, encrypt('apple-refresh-two'));

    const { data, count } = await serviceClient()
      .from('apple_grants')
      .select('refresh_token_ciphertext', { count: 'exact' })
      .eq('user_id', user.id);

    expect(count).toBe(1);
    expect(decryptToken(keyring, data![0]!.refresh_token_ciphertext)).toBe('apple-refresh-two');
  });

  it('keeps one grant per user', async () => {
    await repository.upsert(stranger.id, encrypt('someone-elses-token'));

    const { count } = await serviceClient()
      .from('apple_grants')
      .select('user_id', { count: 'exact' })
      .eq('user_id', user.id);

    expect(count).toBe(1);
    expect(await repository.exists(stranger.id)).toBe(true);
  });

  /** The same helper the service uses, so a format change breaks this test. */
  function encrypt(plaintext: string): string {
    return encryptToken(keyring, plaintext);
  }
});
