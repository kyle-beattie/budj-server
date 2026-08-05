import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponses, idParamSchema } from '../../lib/http.js';
import { RulesRepository } from './rules.repository.js';
import { RulesService } from './rules.service.js';
import {
  createRuleSchema,
  evaluateRulesBodySchema,
  evaluateRulesResponseSchema,
  listRulesQuerySchema,
  ruleListSchema,
  ruleSchema,
  updateRuleSchema,
} from './rules.types.js';

/**
 * Built per request, not once at registration: the Supabase client carries the
 * caller's access token so PostgREST applies their RLS policies.
 */
function serviceFor(request: FastifyRequest): RulesService {
  return new RulesService(new RulesRepository(request.supabase!));
}

const rulesRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.addHook('onRequest', fastify.requireAuth);

  fastify.get(
    '',
    {
      schema: {
        tags: ['rules'],
        summary: 'List the current user’s rules, lowest priority first',
        querystring: listRulesQuerySchema,
        response: { 200: ruleListSchema, ...errorResponses },
      },
    },
    async (request) => serviceFor(request).list(request.auth!.userId, request.query),
  );

  fastify.get(
    '/:id',
    {
      schema: {
        tags: ['rules'],
        summary: 'Fetch a single rule',
        params: idParamSchema,
        response: { 200: ruleSchema, ...errorResponses },
      },
    },
    async (request) => serviceFor(request).getById(request.auth!.userId, request.params.id),
  );

  fastify.post(
    '',
    {
      schema: {
        tags: ['rules'],
        summary: 'Create a rule',
        body: createRuleSchema,
        response: { 201: ruleSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const rule = await serviceFor(request).create(request.auth!.userId, request.body);
      return reply.status(201).send(rule);
    },
  );

  fastify.patch(
    '/:id',
    {
      schema: {
        tags: ['rules'],
        summary: 'Update a rule',
        params: idParamSchema,
        body: updateRuleSchema,
        response: { 200: ruleSchema, ...errorResponses },
      },
    },
    async (request) => serviceFor(request).update(request.auth!.userId, request.params.id, request.body),
  );

  fastify.delete(
    '/:id',
    {
      schema: {
        tags: ['rules'],
        summary: 'Delete a rule',
        params: idParamSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      await serviceFor(request).remove(request.auth!.userId, request.params.id);
      return reply.status(204).send(null);
    },
  );

  fastify.post(
    '/evaluate',
    {
      schema: {
        tags: ['rules'],
        summary: 'Dry-run the enabled rules against a candidate transaction',
        body: evaluateRulesBodySchema,
        response: { 200: evaluateRulesResponseSchema, ...errorResponses },
      },
    },
    async (request) => serviceFor(request).evaluate(request.auth!.userId, request.body.transaction),
  );
};

export default rulesRoutes;
