import { afterAll, expect, it } from 'vitest';
import { cleanupTestUsers, describeIntegration, serviceClient, signUpTestUser } from './harness.js';

/**
 * The `handle_new_user` trigger, exercised for the first time against a real
 * database. Everything here was previously an assertion in a comment.
 */
describeIntegration('handle_new_user', () => {
  afterAll(cleanupTestUsers);

  it('creates exactly one profile row for a new user', async () => {
    const user = await signUpTestUser();

    const { data, error, count } = await serviceClient()
      .from('profiles')
      .select('id, display_name', { count: 'exact' })
      .eq('id', user.id);

    expect(error).toBeNull();
    expect(count).toBe(1);
    expect(data?.[0]?.id).toBe(user.id);
  });

  it('captures full_name from the identity claims', async () => {
    const user = await signUpTestUser({ full_name: 'Ada Lovelace' });

    const { data } = await serviceClient()
      .from('profiles')
      .select('display_name')
      .eq('id', user.id)
      .single();

    expect(data?.display_name).toBe('Ada Lovelace');
  });

  it('prefers our own display_name over the provider claims', async () => {
    const user = await signUpTestUser({ display_name: 'Ada', full_name: 'Ada Lovelace' });

    const { data } = await serviceClient()
      .from('profiles')
      .select('display_name')
      .eq('id', user.id)
      .single();

    expect(data?.display_name).toBe('Ada');
  });

  it('falls back to name when full_name is absent', async () => {
    const user = await signUpTestUser({ name: 'Grace Hopper' });

    const { data } = await serviceClient()
      .from('profiles')
      .select('display_name')
      .eq('id', user.id)
      .single();

    expect(data?.display_name).toBe('Grace Hopper');
  });

  /**
   * The reason the email fallback was removed. Apple's Hide My Email produces
   * addresses like `xyzabc123@privaterelay.appleid.com`; the old trigger named
   * that person `xyzabc123`. An empty name is a prompt the app can resolve — a
   * relay fragment looks like a real answer and never gets corrected.
   */
  it('leaves the display name empty for a private relay address', async () => {
    const user = await signUpTestUser({}, 'xyzabc123@privaterelay.appleid.com');

    const { data } = await serviceClient()
      .from('profiles')
      .select('display_name')
      .eq('id', user.id)
      .single();

    expect(data?.display_name).toBe('');
    expect(data?.display_name).not.toContain('xyzabc123');
  });
});
