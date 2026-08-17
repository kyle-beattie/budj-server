import { z } from 'zod';
import { PLAN_CODES } from './plans.js';

/**
 * Wire shapes for billing.
 *
 * Apple's decoded payloads are validated with Zod rather than trusted as typed
 * JSON: they arrive from outside, and by the time they reach here they have
 * been signature-verified but not *shape*-verified. A missing
 * `originalTransactionId` must be a clean rejection, not `undefined` written
 * into a unique column.
 */

export const subscriptionStatuses = ['active', 'grace_period', 'expired', 'revoked'] as const;
export const subscriptionStatusSchema = z.enum(subscriptionStatuses);
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

/** The body Apple POSTs. The whole notification is inside the JWS. */
export const notificationEnvelopeSchema = z.object({
  signedPayload: z.string().min(1),
});

/**
 * Notification types this server acts on. Anything else — and Apple sends a
 * good deal else — is acknowledged and ignored rather than treated as an error.
 */
export const handledNotificationTypes = [
  'SUBSCRIBED',
  'DID_RENEW',
  'DID_CHANGE_RENEWAL_STATUS',
  'EXPIRED',
  'DID_FAIL_TO_RENEW',
  'GRACE_PERIOD_EXPIRED',
  'REFUND',
] as const;
export type HandledNotificationType = (typeof handledNotificationTypes)[number];

/** Decoded `signedPayload`. Only the fields this server reads are modelled. */
export const decodedNotificationSchema = z.object({
  notificationType: z.string().min(1),
  subtype: z.string().optional(),
  notificationUUID: z.string().min(1),
  /** Milliseconds since epoch, per Apple. */
  signedDate: z.number().int().optional(),
  data: z
    .object({
      bundleId: z.string().optional(),
      environment: z.string().optional(),
      signedTransactionInfo: z.string().optional(),
      signedRenewalInfo: z.string().optional(),
    })
    .optional(),
});
export type DecodedNotification = z.infer<typeof decodedNotificationSchema>;

/** Decoded `signedTransactionInfo`. */
export const decodedTransactionSchema = z.object({
  originalTransactionId: z.string().min(1),
  transactionId: z.string().optional(),
  productId: z.string().min(1),
  bundleId: z.string().optional(),
  /** Milliseconds since epoch. Absent for a non-renewing purchase. */
  expiresDate: z.number().int().optional(),
  revocationDate: z.number().int().optional(),
  environment: z.string().optional(),
});
export type DecodedTransaction = z.infer<typeof decodedTransactionSchema>;

// ---- API responses ---------------------------------------------------------

export const planSchema = z.object({
  code: z.enum(PLAN_CODES),
  name: z.string(),
  productId: z.string(),
  maxRules: z.number().int(),
  maxConnections: z.number().int(),
  effects: z.array(z.enum(['notify', 'transfer'])),
});

export const subscriptionSchema = z.object({
  planCode: z.enum(PLAN_CODES).nullable(),
  productId: z.string().nullable(),
  status: subscriptionStatusSchema.nullable(),
  expiresAt: z.iso.datetime().nullable(),
  /** Whether the caller is entitled right now. The only field a gate reads. */
  active: z.boolean(),
});
export type SubscriptionView = z.infer<typeof subscriptionSchema>;

/**
 * The signed transaction StoreKit hands the app after a purchase.
 *
 * Everything meaningful is inside the JWS. Nothing else is accepted — no
 * product id, no user id, no plan — because a field outside the signature is a
 * field the caller chose.
 */
export const submitTransactionSchema = z.object({
  signedTransaction: z.string().min(1),
});
export type SubmitTransactionInput = z.infer<typeof submitTransactionSchema>;

export const planListSchema = z.object({
  data: z.array(planSchema),
});

/**
 * Apple requires a 200 to consider a notification delivered; a non-2xx makes it
 * retry. `handled: false` still returns 200 — it means the type was one we
 * ignore, which is not a failure and must not be retried.
 */
export const notificationResultSchema = z.object({
  handled: z.boolean(),
});
