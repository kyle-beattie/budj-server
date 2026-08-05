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

const accountsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const service = new AccountsService(new AccountsRepository(fastify.db));

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
    async (request) => service.list(request.auth!.user.id, request.query),
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
    async (request) => service.getById(request.auth!.user.id, request.params.id),
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
      const account = await service.create(request.auth!.user.id, request.body);
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
    async (request) => service.update(request.auth!.user.id, request.params.id, request.body),
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
      await service.remove(request.auth!.user.id, request.params.id);
      return reply.status(204).send(null);
    },
  );
};

export default accountsRoutes;
