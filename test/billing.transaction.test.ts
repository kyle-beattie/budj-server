import { createPrivateKey } from 'node:crypto';
import { SignJWT } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppleJwsVerificationError } from '../src/modules/billing/apple-jws.js';
import type {
  BillingRepository,
  EntitlementWrite,
  SubscriptionRow,
} from '../src/modules/billing/billing.repository.js';
import { BillingService } from '../src/modules/billing/billing.service.js';
import { budjTestRootPem, leafPrivateKeyPem, validChain } from './fixtures/apple-jws-chain.js';

/**
 * Purchase submission. The user always comes from the verified JWT; everything
 * else has to survive the signature and this deployment's own configuration.
 */

const anchor = { rootPem: budjTestRootPem };
const NOW = new Date('2026-08-17T00:00:00Z');
const FUTURE = Date.parse('2026-09-17T00:00:00Z');

/** Matches the placeholders in `.env.example`, which the suite loads. */
const BUNDLE_ID = 'com.example.budj';

async function signedTransaction(overrides: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({
    originalTransactionId: 'otx-1',
    transactionId: 'tx-1',
    productId: 'com.budj.standard.yearly',
    bundleId: BUNDLE_ID,
    environment: 'Sandbox',
    expiresDate: FUTURE,
    ...overrides,
  })
    .setProtectedHeader({ alg: 'ES256', x5c: validChain })
    .sign(createPrivateKey(leafPrivateKeyPem));
}

function row(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    user_id: 'user-1',
    original_transaction_id: 'otx-1',
    product_id: 'com.budj.standard.yearly',
    plan_code: 'standard',
    status: 'active',
    expires_at: new Date(FUTURE).toISOString(),
    last_notification_uuid: null,
    last_notification_at: null,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  } as SubscriptionRow;
}

describe('BillingService.submitTransaction', () => {
  let writes: EntitlementWrite[];
  let byOriginal: SubscriptionRow | undefined;
  let service: BillingService;

  beforeEach(() => {
    writes = [];
    byOriginal = undefined;

    const repository = {
      findByUserId: async () => byOriginal,
      findByOriginalTransactionId: async () => byOriginal,
      upsert: async (values: EntitlementWrite) => {
        writes.push(values);
        return row({ user_id: values.userId, status: values.status, plan_code: values.planCode });
      },
    } as unknown as BillingRepository;

    service = new BillingService(repository, anchor);
  });

  it('binds a verified transaction to the authenticated user', async () => {
    const view = await service.submitTransaction('user-1', await signedTransaction(), NOW);

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      userId: 'user-1',
      originalTransactionId: 'otx-1',
      planCode: 'standard',
      status: 'active',
    });
    expect(view.active).toBe(true);
  });

  /**
   * The user id is never read from the payload. A transaction naming somebody
   * else changes nothing about who gets entitled.
   */
  it('ignores any user identity inside the payload', async () => {
    await service.submitTransaction(
      'user-1',
      await signedTransaction({ userId: 'user-2', appAccountToken: 'user-2' }),
      NOW,
    );

    expect(writes[0]?.userId).toBe('user-1');
  });

  it('writes nothing when the transaction does not verify', async () => {
    const productionService = new BillingService(
      { findByOriginalTransactionId: async () => undefined } as unknown as BillingRepository,
    );

    await expect(
      productionService.submitTransaction('user-1', await signedTransaction(), NOW),
    ).rejects.toBeInstanceOf(AppleJwsVerificationError);
  });

  it('writes nothing for a payload that is not a JWS', async () => {
    await expect(service.submitTransaction('user-1', 'nonsense', NOW)).rejects.toBeInstanceOf(
      AppleJwsVerificationError,
    );
    expect(writes).toEqual([]);
  });

  /** One App Store subscription entitles exactly one account. */
  it('refuses a subscription already bound to a different user', async () => {
    byOriginal = row({ user_id: 'someone-else' });

    await expect(
      service.submitTransaction('user-1', await signedTransaction(), NOW),
    ).rejects.toThrow(/already linked to another account/);

    expect(writes).toEqual([]);
  });

  /** StoreKit replays unfinished transactions on launch, so this is routine. */
  it('is idempotent when the same user resubmits', async () => {
    byOriginal = row({ user_id: 'user-1' });

    const first = await service.submitTransaction('user-1', await signedTransaction(), NOW);
    const second = await service.submitTransaction('user-1', await signedTransaction(), NOW);

    expect(second).toEqual(first);
    expect(writes[0]).toEqual(writes[1]);
  });

  it('leaves the notification cursor alone so a later notification is not seen as a replay', async () => {
    byOriginal = row({
      user_id: 'user-1',
      last_notification_uuid: 'uuid-7',
      last_notification_at: '2026-08-10T00:00:00.000Z',
    });

    await service.submitTransaction('user-1', await signedTransaction(), NOW);

    expect(writes[0]).toMatchObject({
      notificationUuid: 'uuid-7',
      notificationAt: '2026-08-10T00:00:00.000Z',
    });
  });

  describe('refusals that protect entitlement', () => {
    it('refuses a product this build does not offer', async () => {
      await expect(
        service.submitTransaction(
          'user-1',
          await signedTransaction({ productId: 'com.budj.unknown.tier' }),
          NOW,
        ),
      ).rejects.toThrow(/not offered by this application/);

      expect(writes).toEqual([]);
    });

    it('refuses a transaction issued for a different app', async () => {
      await expect(
        service.submitTransaction(
          'user-1',
          await signedTransaction({ bundleId: 'com.someone.else' }),
          NOW,
        ),
      ).rejects.toThrow(/different application/);
    });

    /**
     * Sandbox and production issue overlapping identifiers. Accepting a sandbox
     * purchase in production is a free subscription for anyone with Xcode.
     */
    it('refuses a transaction from the wrong App Store environment', async () => {
      await expect(
        service.submitTransaction(
          'user-1',
          await signedTransaction({ environment: 'Production' }),
          NOW,
        ),
      ).rejects.toThrow(/environment, which this server does not accept/);
    });

    it('does not resurrect entitlement from a refunded transaction', async () => {
      await service.submitTransaction(
        'user-1',
        await signedTransaction({ revocationDate: Date.parse('2026-08-10T00:00:00Z') }),
        NOW,
      );

      expect(writes[0]?.status).toBe('revoked');
    });

    it('records an already-expired transaction as expired', async () => {
      await service.submitTransaction(
        'user-1',
        await signedTransaction({ expiresDate: Date.parse('2026-01-01T00:00:00Z') }),
        NOW,
      );

      expect(writes[0]?.status).toBe('expired');
    });
  });
});

describe('BillingService.subscriptionFor', () => {
  function serviceReturning(stored: SubscriptionRow | undefined): BillingService {
    return new BillingService({ findByUserId: async () => stored } as unknown as BillingRepository);
  }

  it('reports nothing for a user who has never subscribed', async () => {
    const view = await serviceReturning(undefined).subscriptionFor('user-1', NOW);

    expect(view).toEqual({
      planCode: null,
      productId: null,
      status: null,
      expiresAt: null,
      active: false,
    });
  });

  it('reports an active subscription as active', async () => {
    const view = await serviceReturning(row()).subscriptionFor('user-1', NOW);

    expect(view).toMatchObject({ planCode: 'standard', active: true });
  });

  /**
   * Entitlement is never inferred from the absence of a notification: a missed
   * EXPIRED would otherwise serve someone indefinitely for free.
   */
  it('reports a lapsed subscription as inactive even while its status says active', async () => {
    const stale = row({ status: 'active', expires_at: '2026-01-01T00:00:00.000Z' });

    const view = await serviceReturning(stale).subscriptionFor('user-1', NOW);

    expect(view.status).toBe('active');
    expect(view.active).toBe(false);
  });
});
