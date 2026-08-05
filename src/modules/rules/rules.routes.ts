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

const rulesRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const service = new RulesService(new RulesRepository(fastify.db));

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
    async (request) => service.list(request.auth!.user.id, request.query),
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
    async (request) => service.getById(request.auth!.user.id, request.params.id),
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
      const rule = await service.create(request.auth!.user.id, request.body);
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
    async (request) => service.update(request.auth!.user.id, request.params.id, request.body),
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
      await service.remove(request.auth!.user.id, request.params.id);
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
    async (request) => service.evaluate(request.auth!.user.id, request.body.transaction),
  );
};

export default rulesRoutes;
