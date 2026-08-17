import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { config } from '../../config/index.js';
import { errorResponses, idParamSchema } from '../../lib/http.js';
import { AkahuClient } from './akahu.client.js';
import { AkahuConnectionsRepository } from './connections.repository.js';
import { BankConnectionsService } from './bank-connections.service.js';
import {
  authorisationSchema,
  bankConnectionListSchema,
  completeAuthorisationSchema,
  connectionResultSchema,
  listBankConnectionsQuerySchema,
} from './bank-connections.types.js';
import { AkahuStateRepository } from './state.repository.js';
import { AkahuTokenRepository } from './token.repository.js';

/**
 * Built per request. Reads and projection writes go through the caller's own
 * client so RLS applies; only the two credential tables — which no user client
 * can see — use the service role.
 */
function serviceFor(fastify: FastifyInstance, request: FastifyRequest): BankConnectionsService {
  return new BankConnectionsService(
    new AkahuConnectionsRepository(request.supabase!),
    new AkahuStateRepository(fastify.supabaseAdmin),
    new AkahuTokenRepository(fastify.supabaseAdmin),
    new AkahuClient(config.akahu),
    request.log,
  );
}

/**
 * Bank connections.
 *
 * The whole module sits behind the paywall — connecting a bank costs money on
 * every sync, and there is no free tier.
 *
 * ## Why there is no unauthenticated redirect endpoint
 *
 * Akahu redirects the user's browser back with `code` and `state`. The obvious
 * shape is a `GET` handler that takes both and identifies the user *solely*
 * from the state — which makes the state the only thing standing between a
 * leaked redirect URL and someone else's bank being attached to your account.
 *
 * The client here is a native app. It opens the authorisation URL in a web
 * authentication session, intercepts the redirect itself, and posts the code
 * back **with its own bearer token**. So the exchange is bound twice: by a JWT
 * this server verified, and by a state it issued. Neither alone is trusted.
 *
 * A web client would need the `GET` form, and that is the moment to think hard
 * about it — not now.
 */
const bankConnectionsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.addHook('onRequest', fastify.requireAuth);
  fastify.addHook('onRequest', fastify.requireSubscription);

  fastify.post(
    '/authorise',
    {
      schema: {
        tags: ['bank-connections'],
        summary: 'Begin connecting a bank',
        description:
          'Returns an Akahu authorisation URL to open in a web authentication session. The plan’s connection limit is checked before the URL is issued, so nobody is sent through their bank only to be refused on the way back.',
        response: { 200: authorisationSchema, ...errorResponses },
      },
    },
    async (request) =>
      serviceFor(fastify, request).startAuthorisation(
        request.auth!.userId,
        // Non-null: `requireSubscription` populates this or rejects.
        request.entitlements!,
      ),
  );

  fastify.post(
    '/callback',
    {
      schema: {
        tags: ['bank-connections'],
        summary: 'Complete a bank connection',
        description:
          'Exchanges the authorisation code for a user access token, stores it encrypted, and syncs the account projection. The state is single-use: a replayed callback is refused.',
        body: completeAuthorisationSchema,
        response: { 200: connectionResultSchema, ...errorResponses },
      },
    },
    async (request) =>
      serviceFor(fastify, request).completeAuthorisation(request.auth!.userId, request.body),
  );

  fastify.get(
    '',
    {
      schema: {
        tags: ['bank-connections'],
        summary: 'List the current user’s bank connections',
        querystring: listBankConnectionsQuerySchema,
        response: { 200: bankConnectionListSchema, ...errorResponses },
      },
    },
    async (request) => ({
      data: await serviceFor(fastify, request).list(
        request.auth!.userId,
        request.query.includeDisconnected,
      ),
    }),
  );

  fastify.post(
    '/sync',
    {
      schema: {
        tags: ['bank-connections'],
        summary: 'Re-sync accounts from Akahu',
        response: { 200: connectionResultSchema, ...errorResponses },
      },
    },
    async (request) => serviceFor(fastify, request).resync(request.auth!.userId),
  );

  /**
   * `DELETE` marks the connection disconnected rather than removing it, so
   * anything referencing its accounts can still explain itself.
   */
  fastify.delete(
    '/:id',
    {
      schema: {
        tags: ['bank-connections'],
        summary: 'Disconnect a bank',
        description:
          'Marks the connection and its accounts disconnected. Does not revoke the Akahu token, which covers every connection this user has — losing entitlement is what revokes that.',
        params: idParamSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      await serviceFor(fastify, request).revokeConnection(request.auth!.userId, request.params.id);
      return reply.status(204).send(null);
    },
  );
};

export default bankConnectionsRoutes;
