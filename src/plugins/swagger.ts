import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';
import { config, isProduction } from '../config/index.js';

/** OpenAPI document generated from the Zod route schemas. Disabled in production. */
async function swaggerPlugin(fastify: FastifyInstance): Promise<void> {
  if (isProduction) return;

  await fastify.register(swagger, {
    openapi: {
      info: {
        title: 'Budj API',
        description:
          'Budgeting API. Authentication is handled by better-auth under /api/auth — sign in there first, the session cookie carries through to every other route.',
        version: '0.1.0',
      },
      servers: [{ url: config.auth.baseURL }],
      tags: [
        { name: 'auth', description: 'Sessions and credentials' },
        { name: 'user', description: 'The signed-in user’s profile' },
        { name: 'accounts', description: 'Budget accounts' },
        { name: 'rules', description: 'Transaction classification rules' },
      ],
      components: {
        securitySchemes: {
          sessionCookie: { type: 'apiKey', in: 'cookie', name: 'better-auth.session_token' },
        },
      },
      security: [{ sessionCookie: [] }],
    },
    transform: jsonSchemaTransform,
  });

  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true, persistAuthorization: true },
  });

  fastify.log.info('API docs available at /docs');
}

export default fp(swaggerPlugin, { name: 'swagger' });
