import type { HandledNotificationType, SubscriptionStatus } from './billing.types.js';
import { handledNotificationTypes } from './billing.types.js';

/**
 * What each App Store notification means for entitlement.
 *
 * Kept pure — no I/O, no clock — so the whole table can be tested directly.
 * This is the piece where getting a case wrong either serves a refunded user
 * for free or cuts off a paying one.
 */

/** Statuses that entitle the user right now. */
const ENTITLING: readonly SubscriptionStatus[] = ['active', 'grace_period'];

export function isEntitling(status: SubscriptionStatus | null | undefined): boolean {
  return status ? ENTITLING.includes(status) : false;
}

/**
 * Whether a cached entitlement entitles the caller **right now**.
 *
 * The status alone is not enough. Apple's notifications are the only writer, and
 * the spec is explicit that continued entitlement must never be inferred from
 * the absence of one: a missed or delayed `EXPIRED` would otherwise leave
 * `status: 'active'` serving someone indefinitely for free. So a lapsed
 * `expires_at` refuses regardless of what the status says.
 *
 * `grace_period` is the deliberate exception. Apple is retrying payment and
 * continues to serve the user, and during that window the expiry has by
 * definition already passed — enforcing it there would cut off exactly the
 * people Apple is still trying to bill.
 */
export function isCurrentlyEntitled(
  status: SubscriptionStatus | null | undefined,
  expiresAt: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!isEntitling(status)) return false;
  if (status === 'grace_period') return true;
  if (!expiresAt) return true;

  return new Date(expiresAt).getTime() > now.getTime();
}

export function isHandledNotificationType(value: string): value is HandledNotificationType {
  return (handledNotificationTypes as readonly string[]).includes(value);
}

export interface EntitlementOutcome {
  status: SubscriptionStatus;
  /**
   * True when this notification ends entitlement. Every one of these runs the
   * same revocation path (D9) — expiry, refund, failed renewal and grace period
   * expiry are one local outcome, not four.
   */
  endsEntitlement: boolean;
}

/**
 * Apple decides; this translates. There is no branch here that reflects a
 * choice we get to make — a refund is a refund whether or not the month was
 * already served (D9a).
 */
export function resolveOutcome(
  notificationType: HandledNotificationType,
  subtype: string | undefined,
): EntitlementOutcome {
  switch (notificationType) {
    case 'SUBSCRIBED':
    case 'DID_RENEW':
      return { status: 'active', endsEntitlement: false };

    /**
     * Turning auto-renew off does **not** end entitlement. The user has paid
     * through the current period and keeps it until EXPIRED arrives. Revoking
     * here would cut off someone who is still owed service, and it is a
     * tempting mistake because the notification reads like a cancellation.
     */
    case 'DID_CHANGE_RENEWAL_STATUS':
      return { status: 'active', endsEntitlement: false };

    /**
     * Billing failed. With a grace period Apple keeps serving the user while it
     * retries, so entitlement continues and GRACE_PERIOD_EXPIRED is what
     * eventually ends it. Without one, it is over now.
     */
    case 'DID_FAIL_TO_RENEW':
      return subtype === 'GRACE_PERIOD'
        ? { status: 'grace_period', endsEntitlement: false }
        : { status: 'expired', endsEntitlement: true };

    case 'GRACE_PERIOD_EXPIRED':
    case 'EXPIRED':
      return { status: 'expired', endsEntitlement: true };

    case 'REFUND':
      return { status: 'revoked', endsEntitlement: true };
  }
}

/**
 * Whether an arriving notification should be applied at all.
 *
 * Apple redelivers, and does not guarantee order. Two separate hazards:
 *
 * - **Replay.** The same `notificationUUID` arriving twice must change nothing.
 * - **Reordering.** A stale EXPIRED arriving after a fresh SUBSCRIBED must not
 *   revoke a paying customer. Compared on Apple's `signedDate`, never on our
 *   own `updated_at`, which records when we wrote rather than when Apple spoke.
 */
export function shouldApply(
  incoming: { notificationUuid: string; signedDate: Date | null },
  stored: { lastNotificationUuid: string | null; lastNotificationAt: string | null } | undefined,
): boolean {
  if (!stored) return true;

  if (stored.lastNotificationUuid && stored.lastNotificationUuid === incoming.notificationUuid) {
    return false;
  }

  if (!incoming.signedDate || !stored.lastNotificationAt) return true;

  // Strictly older loses. Equal timestamps are applied: Apple can sign two
  // notifications in the same millisecond, and dropping one silently is worse
  // than applying both when the handlers are already idempotent upserts.
  return incoming.signedDate.getTime() >= new Date(stored.lastNotificationAt).getTime();
}
