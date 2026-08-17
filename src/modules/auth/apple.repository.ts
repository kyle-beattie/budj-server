import { toAppError, type Supabase } from '../../supabase/index.js';

/**
 * Storage for Apple's refresh token.
 *
 * `public.apple_grants` has RLS enabled and **no policies**, and is withheld
 * from `authenticated` in the migration's grants block, so no user client can
 * reach it — not even its owner. That makes the service-role client the only
 * way in, which is the documented custody model (D4/D5), not an oversight.
 *
 * Like `getAkahuToken`, nothing here returns a row to a caller: the service
 * takes what it needs and hands back a boolean.
 */
export class AppleGrantRepository {
  /** Must be a service-role client. A user client sees this table as empty. */
  constructor(private readonly service: Supabase) {}

  /**
   * One grant per user. Re-authorising replaces the stored token rather than
   * accumulating rows — the newest refresh token is the only useful one.
   */
  async upsert(userId: string, refreshTokenCiphertext: string): Promise<void> {
    const { error } = await this.service
      .from('apple_grants')
      .upsert(
        { user_id: userId, refresh_token_ciphertext: refreshTokenCiphertext },
        { onConflict: 'user_id' },
      );

    if (error) throw toAppError(error, { resource: 'Apple grant' });
  }

  /** Whether a grant exists, without reading the credential itself. */
  async exists(userId: string): Promise<boolean> {
    const { data, error } = await this.service
      .from('apple_grants')
      .select('user_id')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw toAppError(error, { resource: 'Apple grant' });
    return data !== null;
  }
}
