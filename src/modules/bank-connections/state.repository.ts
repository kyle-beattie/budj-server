import { randomBytes } from 'node:crypto';
import { toAppError, type Supabase } from '../../supabase/index.js';

/**
 * Single-use, expiring `state` for the Akahu authorisation flow.
 *
 * A state value binds an authorisation attempt to the user who started it. It
 * is a capability: whoever holds it can complete a connection, so it is
 * generated with 256 bits of entropy, stored in a table no user client can
 * read, and refused after its first use.
 *
 * Service role only — `akahu_auth_states` has RLS enabled with no policies.
 */

/** Long enough that abandoning the app mid-flow is fine, short enough to matter. */
const STATE_TTL_MS = 15 * 60 * 1000;

export class AkahuStateRepository {
  constructor(private readonly service: Supabase) {}

  async issue(userId: string, now: Date = new Date()): Promise<string> {
    const state = randomBytes(32).toString('base64url');

    const { error } = await this.service.from('akahu_auth_states').insert({
      state,
      user_id: userId,
      expires_at: new Date(now.getTime() + STATE_TTL_MS).toISOString(),
    });

    if (error) throw toAppError(error, { resource: 'Authorisation state' });
    return state;
  }

  /**
   * Consume a state, returning the user it was issued to, or `null` if it is
   * unknown, expired, or already used.
   *
   * The consume is a **conditional update**, not a read followed by a write:
   * `.is('consumed_at', null)` in the same statement means two simultaneous
   * redirects race in Postgres rather than in Node, and exactly one wins. A
   * check-then-set here would let a replayed redirect through under
   * concurrency, which is precisely the case an attacker would arrange.
   */
  async consume(state: string, now: Date = new Date()): Promise<{ userId: string } | null> {
    const { data, error } = await this.service
      .from('akahu_auth_states')
      .update({ consumed_at: now.toISOString() })
      .eq('state', state)
      .is('consumed_at', null)
      .gt('expires_at', now.toISOString())
      .select('user_id')
      .maybeSingle();

    if (error) throw toAppError(error, { resource: 'Authorisation state' });
    return data ? { userId: data.user_id } : null;
  }

  /**
   * Housekeeping for expired, unconsumed states. Nothing calls this yet — it is
   * here so the table has an obvious answer when someone asks how it is kept
   * from growing forever.
   */
  async purgeExpired(now: Date = new Date()): Promise<void> {
    const { error } = await this.service
      .from('akahu_auth_states')
      .delete()
      .lt('expires_at', now.toISOString());

    if (error) throw toAppError(error, { resource: 'Authorisation state' });
  }
}
