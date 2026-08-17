import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { errorResponses } from '../../lib/http.js';
import { AkahuTokenRepository } from '../bank-connections/token.repository.js';
import { BillingRepository } from '../billing/billing.repository.js';
import { DevicesRepository } from '../devices/devices.repository.js';
import { OnboardingService } from './onboarding.service.js';
import { onboardingStatusSchema } from './onboarding.types.js';

const onboardingRoutes: FastifyPluginAsyncZod = async (fastify) => {
  /**
   * `requireAuth` but deliberately **NOT** `requireSubscription`.
   *
   * This endpoint's entire job is to tell a user which step they are on, and
   * for most callers that answer is `billing`. Gating it behind a subscription
   * means the one person who most needs the answer cannot get it — the app
   * deadlocks at the second screen with no way to discover why.
   *
   * `test/integration/billing.gate.test.ts` asserts this stays open. Do not
   * "tidy" it into line with the other modules.
   */
  fastify.addHook('onRequest', fastify.requireAuth);

  fastify.get(
    '/status',
    {
      schema: {
        tags: ['onboarding'],
        summary: 'Where the current user is in onboarding',
        description:
          'Derived from stored facts on every request — there is no onboarding step column, so this cannot drift. Push registration is reported but never holds a user back from `ready`.',
        response: { 200: onboardingStatusSchema, ...errorResponses },
      },
    },
    async (request) =>
      new OnboardingService(
        new BillingRepository(request.supabase!),
        // Service role: akahu_tokens is invisible to user clients by design.
        new AkahuTokenRepository(fastify.supabaseAdmin),
        new DevicesRepository(request.supabase!),
      ).statusFor(request.auth!.userId),
  );
};

export default onboardingRoutes;
