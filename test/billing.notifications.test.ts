import { createPrivateKey } from 'node:crypto';
import { SignJWT } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppleJwsVerificationError } from '../src/modules/billing/apple-jws.js';
import type { BankAccessRevoker } from '../src/modules/billing/bank-access-revoker.js';
import type {
  BillingRepository,
  EntitlementWrite,
  SubscriptionRow,
} from '../src/modules/billing/billing.repository.js';
import { AppleNotificationService } from '../src/modules/billing/notifications.service.js';
import {
  budjTestRootPem,
  leafPrivateKeyPem,
  validChain,
} from './fixtures/apple-jws-chain.js';

/**
 * The notification pipeline, with Apple's signatures real (against the test
 * anchor) and the database faked.
 *
 * The verifier has its own suite in `test/apple-jws.test.ts`. What is asserted
 * here is what the handler *does* with a verified payload — and, critically,
 * what it does not do with an unverified one.
 */

const anchor = { rootPem: budjTestRootPem };

async function sign(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256', x5c: validChain })
    .sign(createPrivateKey(leafPrivateKeyPem));
}

async function notification(options: {
  type: string;
  subtype?: string;
  uuid?: string;
  signedDate?: number;
  originalTransactionId?: string;
  productId?: string;
  expiresDate?: number;
  omitTransaction?: boolean;
}): Promise<string> {
  const transaction = await sign({
    originalTransactionId: options.originalTransactionId ?? 'otx-1',
    transactionId: 'tx-1',
    productId: options.productId ?? 'com.budj.pro.monthly',
    expiresDate: options.expiresDate ?? Date.parse('2026-09-17T00:00:00Z'),
  });

  return sign({
    notificationType: options.type,
    ...(options.subtype ? { subtype: options.subtype } : {}),
    notificationUUID: options.uuid ?? 'uuid-1',
    signedDate: options.signedDate ?? Date.parse('2026-08-17T10:00:00Z'),
    data: options.omitTransaction ? {} : { signedTransactionInfo: transaction },
  });
}

function existingRow(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    user_id: 'user-1',
    original_transaction_id: 'otx-1',
    product_id: 'com.budj.pro.monthly',
    plan_code: 'pro',
    status: 'active',
    expires_at: '2026-09-17T00:00:00.000Z',
    last_notification_uuid: null,
    last_notification_at: null,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  } as SubscriptionRow;
}

describe('AppleNotificationService', () => {
  let writes: EntitlementWrite[];
  let revoked: string[];
  let row: SubscriptionRow | undefined;
  let service: AppleNotificationService;
  let productionService: AppleNotificationService;

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  } as unknown as Parameters<typeof AppleNotificationService.prototype.constructor>[2];

  beforeEach(() => {
    writes = [];
    revoked = [];
    row = existingRow();

    const repository = {
      findByOriginalTransactionId: async () => row,
      findByUserId: async () => row,
      upsert: async (values: EntitlementWrite) => {
        writes.push(values);
        return existingRow();
      },
    } as unknown as BillingRepository;

    const revoker: BankAccessRevoker = {
      revoke: async (userId: string) => {
        revoked.push(userId);
      },
    };

    // Verifies against the fixture anchor rather than Apple's real root; the
    // signature checking itself is entirely real.
    service = new AppleNotificationService(repository, revoker, logger, anchor);

    // Same handler, but pinned to Apple's real root — used to prove that a
    // payload this suite happily accepts is rejected in production.
    productionService = new AppleNotificationService(repository, revoker, logger);
  });

  const handle = (signedPayload: string) => service.handle(signedPayload);

  it('records entitlement from a verified SUBSCRIBED', async () => {
    const result = await handle(await notification({ type: 'SUBSCRIBED' }));

    expect(result).toEqual({ handled: true });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      userId: 'user-1',
      status: 'active',
      planCode: 'pro',
      originalTransactionId: 'otx-1',
    });
    expect(revoked).toEqual([]);
  });

  it('extends the cached expiry on a verified renewal', async () => {
    const expires = Date.parse('2026-10-17T00:00:00Z');
    await handle(await notification({ type: 'DID_RENEW', expiresDate: expires }));

    expect(writes[0]?.expiresAt).toBe(new Date(expires).toISOString());
    expect(writes[0]?.status).toBe('active');
  });

  /** The assertion that matters most: nothing is written on a bad signature. */
  it('writes nothing when the payload does not verify', async () => {
    const forged = await new SignJWT({ notificationType: 'SUBSCRIBED', notificationUUID: 'x' })
      .setProtectedHeader({ alg: 'ES256', x5c: validChain })
      .sign(createPrivateKey(leafPrivateKeyPem));

    // Verified against Apple's *real* anchor, which this chain does not reach.
    await expect(productionService.handle(forged)).rejects.toBeInstanceOf(AppleJwsVerificationError);

    expect(writes).toEqual([]);
    expect(revoked).toEqual([]);
  });

  it('writes nothing when the payload is not a JWS at all', async () => {
    await expect(handle('garbage')).rejects.toBeInstanceOf(AppleJwsVerificationError);

    expect(writes).toEqual([]);
  });

  it.each([['EXPIRED'], ['REFUND'], ['GRACE_PERIOD_EXPIRED']])(
    '%s revokes bank access',
    async (type) => {
      await handle(await notification({ type }));

      expect(revoked).toEqual(['user-1']);
    },
  );

  it('DID_FAIL_TO_RENEW inside a grace period does not revoke', async () => {
    await handle(await notification({ type: 'DID_FAIL_TO_RENEW', subtype: 'GRACE_PERIOD' }));

    expect(writes[0]?.status).toBe('grace_period');
    expect(revoked).toEqual([]);
  });

  it('DID_FAIL_TO_RENEW without a grace period revokes', async () => {
    await handle(await notification({ type: 'DID_FAIL_TO_RENEW' }));

    expect(revoked).toEqual(['user-1']);
  });

  it('ignores a notification type it has no opinion on', async () => {
    const result = await handle(await notification({ type: 'CONSUMPTION_REQUEST' }));

    expect(result).toEqual({ handled: false });
    expect(writes).toEqual([]);
  });

  /**
   * Apple can notify before the app submits its purchase. There is deliberately
   * no owner to guess at — inventing one is how a stranger's subscription
   * entitles someone else's account.
   */
  it('ignores a notification for a subscription no account has claimed', async () => {
    row = undefined;

    const result = await handle(await notification({ type: 'DID_RENEW' }));

    expect(result).toEqual({ handled: false });
    expect(writes).toEqual([]);
    expect(revoked).toEqual([]);
  });

  it('ignores a notification carrying no transaction info', async () => {
    const result = await handle(await notification({ type: 'DID_RENEW', omitTransaction: true }));

    expect(result).toEqual({ handled: false });
    expect(writes).toEqual([]);
  });

  describe('redelivery and ordering', () => {
    it('changes nothing on an exact redelivery', async () => {
      row = existingRow({ last_notification_uuid: 'uuid-9' });

      const result = await handle(await notification({ type: 'EXPIRED', uuid: 'uuid-9' }));

      expect(result).toEqual({ handled: false });
      expect(writes).toEqual([]);
      expect(revoked).toEqual([]);
    });

    /** A late EXPIRED must not revoke someone who has since resubscribed. */
    it('ignores a stale notification arriving after a newer one', async () => {
      row = existingRow({
        last_notification_uuid: 'uuid-new',
        last_notification_at: '2026-08-17T12:00:00.000Z',
      });

      await handle(
        await notification({
          type: 'EXPIRED',
          uuid: 'uuid-old',
          signedDate: Date.parse('2026-08-17T09:00:00Z'),
        }),
      );

      expect(writes).toEqual([]);
      expect(revoked).toEqual([]);
    });

    it('records the notification identity it applied, so the next replay is caught', async () => {
      await handle(await notification({ type: 'DID_RENEW', uuid: 'uuid-42' }));

      expect(writes[0]).toMatchObject({
        notificationUuid: 'uuid-42',
        notificationAt: '2026-08-17T10:00:00.000Z',
      });
    });
  });

  it('keeps the stored plan when Apple names a product this build predates', async () => {
    await handle(await notification({ type: 'DID_RENEW', productId: 'com.budj.future.annual' }));

    expect(writes[0]?.planCode).toBe('pro');
  });

  it('follows the user to a different plan when the product is known', async () => {
    await handle(await notification({ type: 'DID_RENEW', productId: 'com.budj.starter.monthly' }));

    expect(writes[0]?.planCode).toBe('starter');
  });
});
