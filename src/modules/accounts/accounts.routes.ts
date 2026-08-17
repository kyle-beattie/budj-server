import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { errorResponses, idParamSchema } from '../../lib/http.js';
import { AccountsRepository } from './accounts.repository.js';
import { AccountsService } from './accounts.service.js';
import { accountListSchema, accountSchema, listAccountsQuerySchema } from './accounts.types.js';

/**
 * Built per request, not once at registration: the Supabase client carries the
 * caller's access token so PostgREST applies their RLS policies.
 */
function serviceFor(request: FastifyRequest): AccountsService {
  return new AccountsService(new AccountsRepository(request.supabase!));
}

/**
 * Read-only. `POST`, `PATCH` and `DELETE /api/accounts` were removed when
 * accounts stopped being a user-owned table: an account is a fact Akahu
 * reports, and the connection sync is its only writer. Re-adding a write route
 * here would let a user invent an account that no bank backs.
 */
const accountsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // Every route in this module requires a session.
  fastify.addHook('onRequest', fastify.requireAuth);

  fastify.get(
    '',
    {
      schema: {
        tags: ['accounts'],
        summary: 'List the current user’s connected accounts',
        querystring: listAccountsQuerySchema,
        response: { 200: accountListSchema, ...errorResponses },
      },
    },
    async (request) => serviceFor(request).list(request.auth!.userId, request.query),
  );

  fastify.get(
    '/:id',
    {
      schema: {
        tags: ['accounts'],
        summary: 'Fetch a single connected account',
        params: idParamSchema,
        response: { 200: accountSchema, ...errorResponses },
      },
    },
    async (request) => serviceFor(request).getById(request.auth!.userId, request.params.id),
  );
};

export default accountsRoutes;
