import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { errorResponses } from '../../lib/http.js';
import { AppleJwsVerificationError } from './apple-jws.js';
import { LocalBankAccessRevoker } from './bank-access-revoker.js';
import { BillingRepository } from './billing.repository.js';
import { BillingService } from './billing.service.js';
import {
  notificationEnvelopeSchema,
  notificationResultSchema,
  planListSchema,
  submitTransactionSchema,
  subscriptionSchema,
} from './billing.types.js';
import { AppleNotificationService } from './notifications.service.js';
import { PLAN_LIST } from './plans.js';
import { BadRequestError } from '../../lib/errors.js';

/**
 * Billing.
 *
 * Only the notification endpoint exists so far, and that ordering is
 * deliberate: entitlement state can be *observed* before anything is able to
 * create it. Purchase submission and the subscription gate follow.
 */
const billingRoutes: FastifyPluginAsyncZod = async (fastify) => {
  /**
   * **Unauthenticated on purpose.** Apple does not hold a Supabase session, so
   * there is no JWT to require. The request is authenticated by verifying the
   * JWS certificate chain to Apple's pinned root — see `apple-jws.ts` — which
   * happens before any field of the payload is read.
   *
   * Consequently it runs as service role, and `requireAuth` must not be added
   * here. Doing so would make Apple's deliveries fail, silently, until
   * subscriptions drifted far enough from reality for someone to notice.
   */
  fastify.post(
    '/apple/notifications',
    {
      schema: {
        tags: ['billing'],
        summary: 'App Store Server Notifications V2 endpoint',
        description:
          'Called by Apple, not by clients. Authenticated by JWS certificate chain rather than by JWT. Returns 200 for anything understood or safely ignorable; a non-2xx makes Apple retry.',
        body: notificationEnvelopeSchema,
        response: { 200: notificationResultSchema, ...errorResponses },
      },
    },
    async (request) => {
      const service = new AppleNotificationService(
        new BillingRepository(fastify.supabaseAdmin),
        new LocalBankAccessRevoker(fastify.supabaseAdmin, request.log),
        request.log,
      );

      try {
        return await service.handle(request.body.signedPayload);
      } catch (error) {
        if (error instanceof AppleJwsVerificationError) {
          // 400, not 500: Apple retrying will not make an unverifiable payload
          // verify, and nothing was written.
          request.log.warn({ err: error }, 'Rejected unverifiable App Store notification');
          throw new BadRequestError('Notification failed verification');
        }
        throw error;
      }
    },
  );

  /**
   * The catalogue. Guarded by `requireAuth` but deliberately **not** by
   * `requireSubscription` — you cannot require a subscription in order to see
   * what subscriptions exist.
   *
   * Served from code, so this reads nothing.
   */
  fastify.get(
    '/plans',
    {
      onRequest: [fastify.requireAuth],
      schema: {
        tags: ['billing'],
        summary: 'List the available plans',
        response: { 200: planListSchema, ...errorResponses },
      },
    },
    // Copied out of the readonly catalogue so the serializer gets a plain
    // array; the catalogue itself stays immutable.
    async () => ({ data: PLAN_LIST.map((plan) => ({ ...plan, effects: [...plan.effects] })) }),
  );

  /**
   * The caller's own entitlement. Also ungated: an unsubscribed user asking
   * "am I subscribed?" must get an answer, not a 402.
   */
  fastify.get(
    '/subscription',
    {
      onRequest: [fastify.requireAuth],
      schema: {
        tags: ['billing'],
        summary: 'The current user’s subscription',
        description:
          'There is no cancellation route: the server cannot cancel, pause or refund an App Store subscription — only the user can, in App Store settings.',
        response: { 200: subscriptionSchema, ...errorResponses },
      },
    },
    async (request) =>
      new BillingService(new BillingRepository(request.supabase!)).subscriptionFor(
        request.auth!.userId,
      ),
  );

  /**
   * Purchase submission. `requireAuth` only, for the same reason as above.
   *
   * The write runs as **service role**: `billing_subscriptions` is select-only
   * for its owner, precisely so a user cannot insert their own entitlement. The
   * user id comes from the verified JWT, never from the payload.
   */
  fastify.post(
    '/transaction',
    {
      onRequest: [fastify.requireAuth],
      schema: {
        tags: ['billing'],
        summary: 'Submit a signed StoreKit transaction',
        description:
          'Verifies the transaction against Apple’s certificate chain and binds it to the authenticated user. Idempotent — StoreKit replays unfinished transactions on launch, so resubmitting the same one is expected and changes nothing.',
        body: submitTransactionSchema,
        response: { 200: subscriptionSchema, ...errorResponses },
      },
    },
    async (request) => {
      const service = new BillingService(new BillingRepository(fastify.supabaseAdmin));

      try {
        return await service.submitTransaction(
          request.auth!.userId,
          request.body.signedTransaction,
        );
      } catch (error) {
        if (error instanceof AppleJwsVerificationError) {
          request.log.warn(
            { err: error, userId: request.auth!.userId },
            'Rejected unverifiable StoreKit transaction',
          );
          throw new BadRequestError('Transaction failed verification');
        }
        throw error;
      }
    },
  );
};

export default billingRoutes;
