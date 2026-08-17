import { config } from '../../config/index.js';
import { decryptToken, encryptToken } from '../../lib/token-crypto.js';
import { toAppError, type Supabase } from '../../supabase/index.js';

/**
 * Custody of the Akahu user access token — a bearer credential for someone's
 * bank, and the most sensitive value this system holds.
 *
 * Two locks. `public.akahu_tokens` has RLS enabled with **no policies** and is
 * withheld from `authenticated` in the grants block, so no user client can read
 * it even with a valid JWT. And the value itself is encrypted with a key held
 * in the environment rather than in Postgres, so a database dump alone does not
 * yield bank access for every user.
 *
 * **This is the documented service-role exception (D5).** The rule it bends is
 * "never use the service client to serve a normal request", and the constraint
 * that keeps it narrow is below: the accessor is keyed by a `userId` that comes
 * from a verified JWT, and it returns a *credential*, never a row. Nothing here
 * hands a caller anything they could have asked the database for themselves.
 */
export class AkahuTokenRepository {
  /**
   * Must be a service-role client. A user client sees this table as empty —
   * that is the point, and `test/integration/rls.test.ts` proves it.
   */
  constructor(private readonly service: Supabase) {}

  /**
   * The only non-admin service-role read in the codebase.
   *
   * Returns the decrypted token or `null`. It deliberately does not expose the
   * row: no timestamps, no Akahu user id, nothing that would tempt a caller to
   * treat this as ordinary data access.
   *
   * `userId` must come from the verified JWT. Never pass a value from a request
   * body — that turns one guard into none.
   */
  async getAkahuToken(userId: string): Promise<string | null> {
    const { data, error } = await this.service
      .from('akahu_tokens')
      .select('token_ciphertext')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw toAppError(error, { resource: 'Akahu token' });
    if (!data) return null;

    return decryptToken(config.tokenCrypto.keyring, data.token_ciphertext);
  }

  /** Whether a token exists, without decrypting it. */
  async hasToken(userId: string): Promise<boolean> {
    const { data, error } = await this.service
      .from('akahu_tokens')
      .select('user_id')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw toAppError(error, { resource: 'Akahu token' });
    return data !== null;
  }

  /**
   * Store a token, encrypting on the way in.
   *
   * The plaintext exists only as the argument to this call — it is encrypted
   * before the query is built, so no code path writes it, even transiently.
   */
  async store(userId: string, accessToken: string, akahuUserId: string | null): Promise<void> {
    const { error } = await this.service.from('akahu_tokens').upsert(
      {
        user_id: userId,
        akahu_user_id: akahuUserId,
        token_ciphertext: encryptToken(config.tokenCrypto.keyring, accessToken),
      },
      { onConflict: 'user_id' },
    );

    if (error) throw toAppError(error, { resource: 'Akahu token' });
  }

  /**
   * Forget the stored credential.
   *
   * Call this **after** revoking with Akahu, never before: once the ciphertext
   * is gone there is nothing left to authenticate the revocation with, and the
   * connection stays alive and billable forever.
   */
  async forget(userId: string): Promise<void> {
    const { error } = await this.service.from('akahu_tokens').delete().eq('user_id', userId);

    if (error) throw toAppError(error, { resource: 'Akahu token' });
  }
}
