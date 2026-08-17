import type { FastifyBaseLogger } from 'fastify';
import { toAppError, type Supabase } from '../../supabase/index.js';

/**
 * D9: losing entitlement revokes bank access. It does not merely gate the UI.
 *
 * Two reasons it has to be real. Akahu bills per connected user, so a
 * gated-but-connected cancelled account is a recurring cost with no revenue.
 * And once `add-rule-triggers` lands, a live connection still receiving
 * transaction events for a non-paying user is the system doing work nobody
 * authorised.
 */
export interface BankAccessRevoker {
  /** Idempotent: revoking an already-revoked user must be a no-op, not an error. */
  revoke(userId: string): Promise<void>;
}

/**
 * The half that can be built before the Akahu client exists.
 *
 * Marks every connection and account disconnected, so nothing in this system
 * treats the user as connected. It deliberately **does not delete the stored
 * Akahu token**, and that is the one thing to understand about this class.
 *
 * Calling Akahu's `DELETE /token` needs the client that arrives with the
 * bank-connections module. Deleting our copy of the credential first would
 * destroy the only thing that can perform that call, permanently: Akahu would
 * keep the connection alive, keep billing for it, and we would have no way left
 * to tell it to stop. Keeping the row is recoverable; discarding it is not.
 *
 * So the ordering is fixed for whoever completes this: **call Akahu first, then
 * delete the row.** Until then, a revoked user costs an Akahu subscription fee
 * they no longer pay for — accepted because no user has ever connected a bank,
 * and bank-connections lands before anyone can.
 */
export class LocalBankAccessRevoker implements BankAccessRevoker {
  /** Must be a service-role client: this runs from an unauthenticated webhook. */
  constructor(
    private readonly service: Supabase,
    private readonly logger: FastifyBaseLogger,
  ) {}

  async revoke(userId: string): Promise<void> {
    const revokedAt = new Date().toISOString();

    const { error: connectionError } = await this.service
      .from('akahu_connections')
      .update({ disconnected_at: revokedAt })
      .eq('user_id', userId)
      .is('disconnected_at', null);

    if (connectionError) throw toAppError(connectionError, { resource: 'Bank connection' });

    const { error: accountError } = await this.service
      .from('accounts')
      .update({ disconnected_at: revokedAt })
      .eq('user_id', userId)
      .is('disconnected_at', null);

    if (accountError) throw toAppError(accountError, { resource: 'Account' });

    const { data: token, error: tokenError } = await this.service
      .from('akahu_tokens')
      .select('user_id')
      .eq('user_id', userId)
      .maybeSingle();

    if (tokenError) throw toAppError(tokenError, { resource: 'Akahu token' });

    if (token) {
      this.logger.warn(
        { userId },
        'Entitlement ended for a user with a stored Akahu token. Connections marked disconnected, ' +
          'but the token has NOT been revoked with Akahu — that needs the Akahu client from the ' +
          'bank-connections module. Akahu continues to bill for this user until then.',
      );
    }
  }
}
