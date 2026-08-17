import { config } from '../../config/index.js';
import { ConflictError, UnprocessableEntityError } from '../../lib/errors.js';
import { verifyAppleJws, type VerifyOptions } from './apple-jws.js';
import type { BillingRepository, SubscriptionRow } from './billing.repository.js';
import {
  decodedTransactionSchema,
  type DecodedTransaction,
  type SubscriptionView,
} from './billing.types.js';
import { isCurrentlyEntitled } from './entitlement.js';
import { planByProductId, type PlanCode } from './plans.js';

/**
 * Purchase submission and entitlement reads.
 *
 * The app completes the purchase with StoreKit 2 and posts the signed
 * transaction here. Nothing about that submission is trusted except the
 * signature: the *user* comes from the verified JWT, never from the payload,
 * and the product and environment are checked against this deployment's own
 * configuration before anything is written.
 */
export class BillingService {
  constructor(
    /** Reads may use a user client; writes need service role (select-only table). */
    private readonly repository: BillingRepository,
    private readonly verifyOptions: VerifyOptions = {},
  ) {}

  async subscriptionFor(userId: string, now: Date = new Date()): Promise<SubscriptionView> {
    return toView(await this.repository.findByUserId(userId), now);
  }

  /**
   * Bind a verified App Store transaction to the authenticated user.
   *
   * Idempotent by construction: resubmitting the same transaction re-derives
   * the same row. The app has every reason to resubmit — StoreKit replays
   * unfinished transactions on launch — so this must be boring rather than an
   * error.
   */
  async submitTransaction(
    userId: string,
    signedTransaction: string,
    now: Date = new Date(),
  ): Promise<SubscriptionView> {
    const transaction = decodedTransactionSchema.parse(
      await verifyAppleJws<DecodedTransaction>(signedTransaction, this.verifyOptions),
    );

    this.assertIntendedForThisApp(transaction);

    const plan = planByProductId(transaction.productId);
    if (!plan) {
      // A real Apple purchase of a product this build has no entitlement for.
      // Refusing is the only safe answer: guessing a plan would invent limits
      // nobody agreed to.
      throw new UnprocessableEntityError(
        `Product '${transaction.productId}' is not offered by this application`,
      );
    }

    const existing = await this.repository.findByOriginalTransactionId(
      transaction.originalTransactionId,
    );

    if (existing && existing.user_id !== userId) {
      // One App Store subscription entitles exactly one account. The database
      // enforces this too; refusing here gives a clearer answer than a unique
      // violation, and — importantly — leaves the existing owner untouched.
      throw new ConflictError('That App Store subscription is already linked to another account');
    }

    const expiresAt = transaction.expiresDate ? new Date(transaction.expiresDate) : null;
    const status = resolveSubmittedStatus(transaction, expiresAt, now);

    const row = await this.repository.upsert({
      userId,
      originalTransactionId: transaction.originalTransactionId,
      productId: transaction.productId,
      planCode: plan.code,
      status,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      // Submission is not a notification. Leaving these untouched keeps the
      // replay/ordering guards keyed to Apple's own delivery stream; stamping
      // them here would make a later genuine notification look like a replay.
      notificationUuid: existing?.last_notification_uuid ?? null,
      notificationAt: existing?.last_notification_at ?? null,
    });

    return toView(row, now);
  }

  /**
   * A transaction is only meaningful for the app and environment it was made
   * in. Sandbox and production issue overlapping identifiers, so accepting a
   * sandbox purchase in production is a free subscription for anyone with Xcode.
   */
  private assertIntendedForThisApp(transaction: DecodedTransaction): void {
    if (transaction.bundleId && transaction.bundleId !== config.appStore.bundleId) {
      throw new UnprocessableEntityError('Transaction was issued for a different application');
    }

    if (transaction.environment && transaction.environment !== config.appStore.environment) {
      throw new UnprocessableEntityError(
        `Transaction was issued in the ${transaction.environment} environment, which this server does not accept`,
      );
    }
  }
}

function resolveSubmittedStatus(
  transaction: DecodedTransaction,
  expiresAt: Date | null,
  now: Date,
): 'active' | 'expired' | 'revoked' {
  // Apple refunded it. Submitting it must not resurrect entitlement.
  if (transaction.revocationDate) return 'revoked';
  if (expiresAt && expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'active';
}

function toView(row: SubscriptionRow | undefined, now: Date): SubscriptionView {
  if (!row) {
    return { planCode: null, productId: null, status: null, expiresAt: null, active: false };
  }

  return {
    planCode: (row.plan_code as PlanCode) ?? null,
    productId: row.product_id,
    status: row.status,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    active: isCurrentlyEntitled(row.status, row.expires_at, now),
  };
}
