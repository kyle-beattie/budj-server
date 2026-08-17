import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { errorResponses } from '../../lib/http.js';
import { AppleJwsVerificationError } from './apple-jws.js';
import { LocalBankAccessRevoker } from './bank-access-revoker.js';
import { BillingRepository } from './billing.repository.js';
import { notificationEnvelopeSchema, notificationResultSchema } from './billing.types.js';
import { AppleNotificationService } from './notifications.service.js';
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
};

export default billingRoutes;
