import type { FastifyBaseLogger } from 'fastify';
import type { BankAccessRevoker } from '../billing/bank-access-revoker.js';
import { toAppError, type Supabase } from '../../supabase/index.js';
import type { AkahuClient } from './akahu.client.js';
import { AkahuTokenRepository } from './token.repository.js';

/**
 * The complete D9 revocation path: entitlement ends, bank access goes with it.
 *
 * This replaces `LocalBankAccessRevoker`, which marked connections disconnected
 * but could not tell Akahu, because the client did not exist yet.
 *
 * ## Order is the whole design
 *
 * 1. Read the token.
 * 2. Revoke it **with Akahu**.
 * 3. Only then delete the stored ciphertext.
 * 4. Mark connections and accounts disconnected.
 *
 * Deleting first is the tempting simplification and it is unrecoverable: the
 * ciphertext is the only thing that can authenticate step 2, so losing it
 * leaves the connection live and Akahu billing for a user who has stopped
 * paying, with nothing left to stop it.
 *
 * ## Why a failure at step 2 does not abort
 *
 * Akahu being down must not leave a refunded user with an active connection in
 * our own database. So the local state is always brought to "disconnected",
 * and an Akahu failure is logged loudly with the token **left in place**, so a
 * retry is still possible. The cost of that choice is an occasional orphaned
 * Akahu subscription; the cost of the alternative is serving someone who has
 * been refunded.
 */
export class AkahuBankAccessRevoker implements BankAccessRevoker {
  private readonly tokens: AkahuTokenRepository;

  constructor(
    /** Service role: this runs from an unauthenticated webhook. */
    private readonly service: Supabase,
    private readonly akahu: AkahuClient,
    private readonly logger: FastifyBaseLogger,
  ) {
    this.tokens = new AkahuTokenRepository(service);
  }

  async revoke(userId: string): Promise<void> {
    await this.revokeWithAkahu(userId);
    await this.markDisconnected(userId);
  }

  private async revokeWithAkahu(userId: string): Promise<void> {
    const token = await this.tokens.getAkahuToken(userId);

    // Idempotent: revoking a user who never connected, or who has already been
    // revoked, is a no-op rather than an error.
    if (!token) return;

    try {
      await this.akahu.revokeToken(token);
    } catch (error) {
      this.logger.error(
        { err: error, userId },
        'Failed to revoke the Akahu token. The stored credential has been KEPT so this can be ' +
          'retried — Akahu is still billing for this user until it succeeds. Local connections ' +
          'are being marked disconnected regardless.',
      );
      return;
    }

    // Only now is the credential safe to discard.
    await this.tokens.forget(userId);
  }

  private async markDisconnected(userId: string): Promise<void> {
    const disconnectedAt = new Date().toISOString();

    const { error: connectionError } = await this.service
      .from('akahu_connections')
      .update({ disconnected_at: disconnectedAt })
      .eq('user_id', userId)
      .is('disconnected_at', null);

    if (connectionError) throw toAppError(connectionError, { resource: 'Bank connection' });

    const { error: accountError } = await this.service
      .from('accounts')
      .update({ disconnected_at: disconnectedAt })
      .eq('user_id', userId)
      .is('disconnected_at', null);

    if (accountError) throw toAppError(accountError, { resource: 'Account' });
  }
}
