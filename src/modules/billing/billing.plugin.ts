import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { PaymentRequiredError, UnauthorizedError } from '../../lib/errors.js';
import { BillingRepository } from './billing.repository.js';
import { isCurrentlyEntitled } from './entitlement.js';
import { entitlementsFor, type Plan } from './plans.js';

/**
 * `requireSubscription` — the entitlement gate.
 *
 * There is no free tier, so this is a hard boundary rather than a feature flag:
 * everything past identity requires an active subscription.
 *
 * ## Where it must NOT go
 *
 * - **Onboarding status.** A user who has not paid is precisely the person who
 *   needs to be told which step they are on. Gating it makes the app unable to
 *   discover that billing is what it is waiting for — a deadlock at the second
 *   screen.
 * - **The plan catalogue and purchase submission.** You cannot require a
 *   subscription in order to buy one.
 * - **Auth.** Signing in cannot depend on having paid.
 *
 * ## Ordering
 *
 * `onRequest`, after `requireAuth`, which populates `request.auth` and
 * `request.supabase`. Registering it without `requireAuth` in front is a
 * programming error and throws rather than silently allowing the request.
 */

async function requireSubscription(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!request.auth || !request.supabase) {
    throw new UnauthorizedError('Authentication required');
  }

  // Read through the caller's own client: the owner select policy applies, so
  // this cannot see anyone else's entitlement even if the filter were wrong.
  const row = await new BillingRepository(request.supabase).findByUserId(request.auth.userId);

  if (!isCurrentlyEntitled(row?.status, row?.expires_at)) {
    throw new PaymentRequiredError();
  }

  request.entitlements = entitlementsFor(row?.plan_code ?? null);
}

const billingPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest('entitlements', null);
  fastify.decorate('requireSubscription', requireSubscription);
};

export default fp(billingPlugin, {
  name: 'billing',
  // The gate reads `request.auth`, which the auth plugin's guard populates.
  dependencies: ['auth'],
});

export type { Plan };
