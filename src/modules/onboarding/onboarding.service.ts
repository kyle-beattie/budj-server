import type { BillingRepository } from '../billing/billing.repository.js';
import { isCurrentlyEntitled } from '../billing/entitlement.js';
import type { AkahuTokenRepository } from '../bank-connections/token.repository.js';
import type { DevicesRepository } from '../devices/devices.repository.js';
import type { OnboardingStatus, OnboardingStep } from './onboarding.types.js';

/**
 * Onboarding status, **derived on every request and never stored**.
 *
 * The alternative — an `onboarding_step` column — can disagree with reality,
 * and when it does the user is stuck with no self-service fix: someone who has
 * paid but whose column still reads `billing` is a support ticket. It also
 * makes every new step a migration plus a backfill. Deriving costs three
 * single-row lookups and cannot drift (D1).
 *
 * If you are ever tempted to cache this: the whole point is that a purchase
 * confirmed by an App Store notification is visible on the *very next* status
 * request, with nothing needing to advance it.
 */
export class OnboardingService {
  constructor(
    private readonly billing: BillingRepository,
    private readonly tokens: AkahuTokenRepository,
    private readonly devices: DevicesRepository,
  ) {}

  async statusFor(userId: string, now: Date = new Date()): Promise<OnboardingStatus> {
    const [subscription, bankConnected, pushRegistered] = await Promise.all([
      this.billing.findByUserId(userId),
      /**
       * Token presence, not connection rows.
       *
       * A user whose authorisation succeeded but whose account sync returned
       * nothing has a token and no connections. Keying on connections would
       * send them back through their bank; keying on the token lets them
       * re-sync instead. `hasToken` returns a boolean rather than a row or a
       * credential, so it stays inside the D5 exception rather than widening it.
       */
      this.tokens.hasToken(userId),
      this.devices.hasActiveDevice(userId),
    ]);

    const subscriptionActive = isCurrentlyEntitled(
      subscription?.status,
      subscription?.expires_at,
      now,
    );

    return {
      step: resolveStep(subscriptionActive, bankConnected),
      subscriptionActive,
      planCode: subscription?.plan_code ?? null,
      bankConnected,
      pushRegistered,
    };
  }
}

/**
 * First unsatisfied step wins. Push is deliberately not a case here — it is
 * reported alongside and never held against the user (D12).
 */
function resolveStep(subscriptionActive: boolean, bankConnected: boolean): OnboardingStep {
  if (!subscriptionActive) return 'billing';
  if (!bankConnected) return 'bank';
  return 'ready';
}
