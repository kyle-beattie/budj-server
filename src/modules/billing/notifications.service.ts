import type { FastifyBaseLogger } from 'fastify';
import { verifyAppleJws, type VerifyOptions } from './apple-jws.js';
import type { BankAccessRevoker } from './bank-access-revoker.js';
import type { BillingRepository } from './billing.repository.js';
import {
  decodedNotificationSchema,
  decodedTransactionSchema,
  type DecodedNotification,
  type DecodedTransaction,
} from './billing.types.js';
import { isHandledNotificationType, resolveOutcome, shouldApply } from './entitlement.js';
import { planByProductId } from './plans.js';

/**
 * App Store Server Notifications V2.
 *
 * These are the **only** writer of entitlement state after purchase. The server
 * never polls and never infers continued entitlement from silence — an absent
 * notification means nothing happened, not that everything is fine.
 *
 * Authenticated by Apple's certificate chain, not by JWT, so `requireAuth`
 * cannot apply and this runs as service role. That is the second documented
 * exception in `CLAUDE.md`, and it is structurally different from the first:
 * the request is not user-initiated and returns nothing to a caller.
 */
export class AppleNotificationService {
  constructor(
    private readonly repository: BillingRepository,
    private readonly revoker: BankAccessRevoker,
    private readonly logger: FastifyBaseLogger,
    /**
     * Verification options, for tests only — see `VerifyOptions`. Nobody can
     * mint a chain under Apple's real root, so without this the handler's
     * behaviour on a *verified* payload would be untestable. Production omits
     * it and gets the pinned Apple anchor.
     */
    private readonly verifyOptions: VerifyOptions = {},
  ) {}

  /**
   * Throws only when the notification is unverifiable or malformed — Apple
   * retries a non-2xx, and a retry is the right answer for "we could not read
   * this". Everything else returns, including types this build ignores.
   */
  async handle(signedPayload: string): Promise<{ handled: boolean }> {
    // Verification first, before a single field is read. A payload that has not
    // proven its chain is attacker-controlled text.
    const notification = decodedNotificationSchema.parse(
      await verifyAppleJws<DecodedNotification>(signedPayload, this.verifyOptions),
    );

    if (!isHandledNotificationType(notification.notificationType)) {
      // Apple sends a good deal this server has no opinion on. Acknowledged, so
      // it is not retried forever.
      this.logger.debug(
        { notificationType: notification.notificationType },
        'Ignoring unhandled App Store notification type',
      );
      return { handled: false };
    }

    const signedTransactionInfo = notification.data?.signedTransactionInfo;
    if (!signedTransactionInfo) {
      this.logger.warn(
        { notificationType: notification.notificationType, uuid: notification.notificationUUID },
        'App Store notification carried no transaction info; nothing to apply',
      );
      return { handled: false };
    }

    const transaction = decodedTransactionSchema.parse(
      await verifyAppleJws<DecodedTransaction>(signedTransactionInfo, this.verifyOptions),
    );

    return this.apply(notification, transaction);
  }

  private async apply(
    notification: DecodedNotification,
    transaction: DecodedTransaction,
  ): Promise<{ handled: boolean }> {
    const existing = await this.repository.findByOriginalTransactionId(
      transaction.originalTransactionId,
    );

    if (!existing) {
      /**
       * A notification for a subscription no account has claimed yet. This is
       * ordinary: Apple can notify before the app submits its transaction.
       *
       * There is deliberately no account to guess at — `original_transaction_id`
       * is the only join Apple gives us, and inventing an owner is how one
       * person's subscription entitles another's account.
       */
      this.logger.info(
        {
          notificationType: notification.notificationType,
          originalTransactionId: transaction.originalTransactionId,
        },
        'App Store notification for an unlinked subscription; ignored until the purchase is submitted',
      );
      return { handled: false };
    }

    const signedDate = notification.signedDate ? new Date(notification.signedDate) : null;

    if (
      !shouldApply(
        { notificationUuid: notification.notificationUUID, signedDate },
        {
          lastNotificationUuid: existing.last_notification_uuid,
          lastNotificationAt: existing.last_notification_at,
        },
      )
    ) {
      this.logger.debug(
        { uuid: notification.notificationUUID },
        'Skipping replayed or out-of-order App Store notification',
      );
      return { handled: false };
    }

    const outcome = resolveOutcome(
      notification.notificationType as Parameters<typeof resolveOutcome>[0],
      notification.subtype,
    );

    // Keep the recorded plan honest if the user changed products; fall back to
    // what is already stored when Apple names a product this build predates.
    const planCode = planByProductId(transaction.productId)?.code ?? existing.plan_code;

    await this.repository.upsert({
      userId: existing.user_id,
      originalTransactionId: transaction.originalTransactionId,
      productId: transaction.productId,
      planCode,
      status: outcome.status,
      expiresAt: transaction.expiresDate ? new Date(transaction.expiresDate).toISOString() : null,
      notificationUuid: notification.notificationUUID,
      notificationAt: signedDate ? signedDate.toISOString() : null,
    });

    if (outcome.endsEntitlement) {
      // Every route to lost entitlement runs the same revocation (D9).
      await this.revoker.revoke(existing.user_id);
    }

    this.logger.info(
      {
        userId: existing.user_id,
        notificationType: notification.notificationType,
        status: outcome.status,
      },
      'Applied App Store notification',
    );

    return { handled: true };
  }
}
