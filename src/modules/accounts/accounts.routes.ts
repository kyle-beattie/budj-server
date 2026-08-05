import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponses, idParamSchema } from '../../lib/http.js';
import { AccountsRepository } from './accounts.repository.js';
import { AccountsService } from './accounts.service.js';
import {
  accountListSchema,
  accountSchema,
  createAccountSchema,
  listAccountsQuerySchema,
  updateAccountSchema,
} from './accounts.types.js';

/**
 * Built per request, not once at registration: the Supabase client carries the
 * caller's access token so PostgREST applies their RLS policies.
 */
function serviceFor(request: FastifyRequest): AccountsService {
  return new AccountsService(new AccountsRepository(request.supabase!));
}

const accountsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // Every route in this module requires a session.
  fastify.addHook('onRequest', fastify.requireAuth);

  fastify.get(
    '',
    {
      schema: {
        tags: ['accounts'],
        summary: 'List the current user’s accounts',
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
        summary: 'Fetch a single account',
        params: idParamSchema,
        response: { 200: accountSchema, ...errorResponses },
      },
    },
    async (request) => serviceFor(request).getById(request.auth!.userId, request.params.id),
  );

  fastify.post(
    '',
    {
      schema: {
        tags: ['accounts'],
        summary: 'Create an account',
        body: createAccountSchema,
        response: { 201: accountSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const account = await serviceFor(request).create(request.auth!.userId, request.body);
      return reply.status(201).send(account);
    },
  );

  fastify.patch(
    '/:id',
    {
      schema: {
        tags: ['accounts'],
        summary: 'Update an account',
        params: idParamSchema,
        body: updateAccountSchema,
        response: { 200: accountSchema, ...errorResponses },
      },
    },
    async (request) => serviceFor(request).update(request.auth!.userId, request.params.id, request.body),
  );

  fastify.delete(
    '/:id',
    {
      schema: {
        tags: ['accounts'],
        summary: 'Delete an account',
        params: idParamSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      await serviceFor(request).remove(request.auth!.userId, request.params.id);
      return reply.status(204).send(null);
    },
  );
};

export default accountsRoutes;
