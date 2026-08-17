import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AkahuTokenRepository } from '../src/modules/bank-connections/token.repository.js';
import type { BillingRepository, SubscriptionRow } from '../src/modules/billing/billing.repository.js';
import type { DevicesRepository } from '../src/modules/devices/devices.repository.js';
import { OnboardingService } from '../src/modules/onboarding/onboarding.service.js';

const NOW = new Date('2026-08-17T00:00:00Z');

function serviceWith(options: {
  subscription?: Partial<SubscriptionRow> | null;
  hasToken?: boolean;
  hasDevice?: boolean;
}): OnboardingService {
  return new OnboardingService(
    {
      findByUserId: async () =>
        options.subscription === null || options.subscription === undefined
          ? undefined
          : ({
              status: 'active',
              expires_at: '2099-01-01T00:00:00.000Z',
              plan_code: 'pro',
              ...options.subscription,
            } as SubscriptionRow),
    } as unknown as BillingRepository,
    { hasToken: async () => options.hasToken ?? false } as unknown as AkahuTokenRepository,
    { hasActiveDevice: async () => options.hasDevice ?? false } as unknown as DevicesRepository,
  );
}

describe('onboarding status', () => {
  it('reports billing for a user who has just signed in', async () => {
    const status = await serviceWith({ subscription: null }).statusFor('user-1', NOW);

    expect(status.step).toBe('billing');
    expect(status.subscriptionActive).toBe(false);
    expect(status.planCode).toBeNull();
  });

  it('reports bank once subscribed but with no bank connected', async () => {
    const status = await serviceWith({ subscription: {}, hasToken: false }).statusFor('user-1', NOW);

    expect(status.step).toBe('bank');
    expect(status.subscriptionActive).toBe(true);
    expect(status.planCode).toBe('pro');
  });

  it('reports ready once subscribed and connected', async () => {
    const status = await serviceWith({ subscription: {}, hasToken: true }).statusFor('user-1', NOW);

    expect(status.step).toBe('ready');
    expect(status.bankConnected).toBe(true);
  });

  /**
   * D12: a rule that cannot notify cannot be approved, so push matters — but
   * permission denial must not brick the app. Reported, never enforced.
   */
  it('reports ready with push outstanding when notifications were declined', async () => {
    const status = await serviceWith({
      subscription: {},
      hasToken: true,
      hasDevice: false,
    }).statusFor('user-1', NOW);

    expect(status.step).toBe('ready');
    expect(status.pushRegistered).toBe(false);
  });

  it('reports push as registered once a device exists', async () => {
    const status = await serviceWith({
      subscription: {},
      hasToken: true,
      hasDevice: true,
    }).statusFor('user-1', NOW);

    expect(status.pushRegistered).toBe(true);
  });

  /**
   * A lapsed subscription sends the user back to billing even while its status
   * still reads `active` — the same rule the gate uses, so the step and the 402
   * can never disagree.
   */
  it('sends a silently lapsed subscriber back to billing', async () => {
    const status = await serviceWith({
      subscription: { status: 'active', expires_at: '2020-01-01T00:00:00.000Z' },
      hasToken: true,
    }).statusFor('user-1', NOW);

    expect(status.step).toBe('billing');
    expect(status.subscriptionActive).toBe(false);
  });

  it('keeps a grace-period subscriber past the billing step', async () => {
    const status = await serviceWith({
      subscription: { status: 'grace_period', expires_at: '2020-01-01T00:00:00.000Z' },
      hasToken: true,
    }).statusFor('user-1', NOW);

    expect(status.step).toBe('ready');
  });

  it.each([['expired'], ['revoked']] as const)('sends a %s subscriber back to billing', async (status) => {
    const result = await serviceWith({
      subscription: { status },
      hasToken: true,
    }).statusFor('user-1', NOW);

    expect(result.step).toBe('billing');
  });

  /**
   * Billing is checked before bank. A user who lost entitlement while connected
   * must be told to fix billing, not sent back through their bank.
   */
  it('prefers the billing step over the bank step', async () => {
    const status = await serviceWith({ subscription: null, hasToken: false }).statusFor('user-1', NOW);

    expect(status.step).toBe('billing');
  });
});

/**
 * Task 9.4, as a test rather than an inspection.
 *
 * Onboarding state is derived from facts that must exist anyway. A column
 * recording the step could disagree with reality, and when it did the user
 * would be stuck with no self-service fix. This fails if one is ever added.
 */
describe('the schema carries no onboarding step', () => {
  const generatedTypes = readFileSync(
    resolve(process.cwd(), 'src/supabase/database.types.ts'),
    'utf8',
  );

  it.each([
    ['onboarding_step'],
    ['onboarding_stage'],
    ['onboarding_state'],
    ['onboarding_status'],
    ['onboarding_completed'],
    ['current_step'],
  ])('has no %s column', (column) => {
    expect(generatedTypes).not.toContain(column);
  });

  it('mentions onboarding nowhere in the generated types at all', () => {
    expect(generatedTypes.toLowerCase()).not.toContain('onboarding');
  });
});
