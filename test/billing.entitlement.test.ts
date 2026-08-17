import { describe, expect, it } from 'vitest';
import {
  isCurrentlyEntitled,
  isEntitling,
  isHandledNotificationType,
  resolveOutcome,
  shouldApply,
} from '../src/modules/billing/entitlement.js';
import { PLANS, entitlementsFor, planByCode, planByProductId } from '../src/modules/billing/plans.js';

describe('resolveOutcome', () => {
  it.each([
    ['SUBSCRIBED', undefined, 'active', false],
    ['DID_RENEW', undefined, 'active', false],
    ['EXPIRED', undefined, 'expired', true],
    ['GRACE_PERIOD_EXPIRED', undefined, 'expired', true],
    ['REFUND', undefined, 'revoked', true],
    ['DID_FAIL_TO_RENEW', 'GRACE_PERIOD', 'grace_period', false],
    ['DID_FAIL_TO_RENEW', undefined, 'expired', true],
  ] as const)('%s/%s → %s (ends: %s)', (type, subtype, status, ends) => {
    expect(resolveOutcome(type, subtype)).toEqual({ status, endsEntitlement: ends });
  });

  /**
   * The tempting mistake. Turning auto-renew off reads like a cancellation, but
   * the user has paid through the current period — revoking here cuts off
   * someone still owed service. EXPIRED is what ends it, later.
   */
  it('does not end entitlement when the user turns auto-renew off', () => {
    const outcome = resolveOutcome('DID_CHANGE_RENEWAL_STATUS', 'AUTO_RENEW_DISABLED');

    expect(outcome.endsEntitlement).toBe(false);
    expect(outcome.status).toBe('active');
  });

  /** D9a: four different notifications, one local outcome. */
  it('routes every entitlement-ending notification to the same revocation', () => {
    const ending = (['EXPIRED', 'GRACE_PERIOD_EXPIRED', 'REFUND'] as const).map(
      (type) => resolveOutcome(type, undefined).endsEntitlement,
    );
    ending.push(resolveOutcome('DID_FAIL_TO_RENEW', undefined).endsEntitlement);

    expect(ending).toEqual([true, true, true, true]);
  });
});

describe('isEntitling', () => {
  it.each([
    ['active', true],
    ['grace_period', true],
    ['expired', false],
    ['revoked', false],
  ] as const)('%s → %s', (status, entitled) => {
    expect(isEntitling(status)).toBe(entitled);
  });

  /** No free tier: absent entitlement is not reduced entitlement. */
  it.each([[null], [undefined]])('treats %s as not entitled', (status) => {
    expect(isEntitling(status)).toBe(false);
  });
});

describe('isCurrentlyEntitled', () => {
  const now = new Date('2026-08-17T00:00:00Z');
  const future = '2026-09-17T00:00:00.000Z';
  const past = '2026-01-01T00:00:00.000Z';

  it('entitles an active subscription that has not expired', () => {
    expect(isCurrentlyEntitled('active', future, now)).toBe(true);
  });

  /**
   * The rule that stops a missed notification becoming a free subscription.
   * Apple's notifications are the only writer, and entitlement must never be
   * inferred from the absence of one.
   */
  it('refuses an active subscription whose expiry has passed', () => {
    expect(isCurrentlyEntitled('active', past, now)).toBe(false);
  });

  /**
   * The deliberate exception: during a grace period the expiry has by
   * definition already passed while Apple retries payment. Enforcing it here
   * cuts off exactly the people Apple is still trying to bill.
   */
  it('entitles a grace period even though its expiry has passed', () => {
    expect(isCurrentlyEntitled('grace_period', past, now)).toBe(true);
  });

  it.each([['expired'], ['revoked']] as const)('never entitles %s', (status) => {
    expect(isCurrentlyEntitled(status, future, now)).toBe(false);
  });

  it('refuses a caller with no subscription at all', () => {
    expect(isCurrentlyEntitled(null, null, now)).toBe(false);
  });

  it('entitles an active subscription with no recorded expiry', () => {
    expect(isCurrentlyEntitled('active', null, now)).toBe(true);
  });

  it('treats the exact expiry instant as expired', () => {
    expect(isCurrentlyEntitled('active', now.toISOString(), now)).toBe(false);
  });
});

describe('isHandledNotificationType', () => {
  it('accepts the types this server acts on', () => {
    expect(isHandledNotificationType('DID_RENEW')).toBe(true);
  });

  it('rejects types Apple sends that this server has no opinion on', () => {
    expect(isHandledNotificationType('CONSUMPTION_REQUEST')).toBe(false);
    expect(isHandledNotificationType('')).toBe(false);
  });
});

describe('shouldApply', () => {
  const stored = {
    lastNotificationUuid: 'uuid-1',
    lastNotificationAt: '2026-08-17T10:05:00.000Z',
  };

  it('applies anything when there is no stored notification yet', () => {
    expect(shouldApply({ notificationUuid: 'uuid-1', signedDate: new Date() }, undefined)).toBe(true);
  });

  /** Apple redelivers. The same UUID twice must change nothing. */
  it('rejects an exact redelivery', () => {
    expect(
      shouldApply({ notificationUuid: 'uuid-1', signedDate: new Date('2026-08-17T10:00:00Z') }, stored),
    ).toBe(false);
  });

  it('applies a newer notification', () => {
    expect(
      shouldApply({ notificationUuid: 'uuid-2', signedDate: new Date('2026-08-17T10:06:00Z') }, stored),
    ).toBe(true);
  });

  /** The one that revokes a paying customer if it goes wrong. */
  it('rejects a stale notification that arrives late', () => {
    expect(
      shouldApply({ notificationUuid: 'uuid-0', signedDate: new Date('2026-08-17T09:00:00Z') }, stored),
    ).toBe(false);
  });

  /**
   * Deliberately comparing Apple's signedDate, never our updated_at. A
   * notification signed at 10:02 and delivered at 10:06 is newer than one
   * signed at 10:00 that we happened to write at 10:05.
   */
  it('applies a notification signed before we wrote the previous one but after it was signed', () => {
    expect(
      shouldApply(
        { notificationUuid: 'uuid-2', signedDate: new Date('2026-08-17T10:05:30Z') },
        stored,
      ),
    ).toBe(true);
  });

  it('applies when either side carries no timestamp', () => {
    expect(shouldApply({ notificationUuid: 'uuid-2', signedDate: null }, stored)).toBe(true);
    expect(
      shouldApply(
        { notificationUuid: 'uuid-2', signedDate: new Date() },
        { lastNotificationUuid: 'uuid-1', lastNotificationAt: null },
      ),
    ).toBe(true);
  });
});

describe('the plan catalogue', () => {
  it('resolves a plan from its stored code', () => {
    expect(planByCode('pro')).toBe(PLANS.pro);
    expect(planByCode('enterprise')).toBeUndefined();
  });

  it('resolves a plan from an App Store product identifier', () => {
    expect(planByProductId(PLANS.starter.productId)).toBe(PLANS.starter);
  });

  /** A notification for a product published after this build shipped. */
  it('returns nothing for an unknown product rather than guessing', () => {
    expect(planByProductId('com.budj.something.new')).toBeUndefined();
  });

  it('gives an unsubscribed user no entitlements at all', () => {
    expect(entitlementsFor(null)).toBeNull();
    expect(entitlementsFor('')).toBeNull();
    expect(entitlementsFor('enterprise')).toBeNull();
  });

  it('reads limits from code, never from storage', () => {
    expect(entitlementsFor('pro')).toMatchObject({ maxRules: 100, maxConnections: 10 });
    expect(entitlementsFor('starter')?.effects).toEqual(['notify']);
  });

  it('gives every plan a distinct product identifier', () => {
    const ids = Object.values(PLANS).map((plan) => plan.productId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
