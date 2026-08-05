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
          'Budgeting API. POST /api/auth/sign-in to get an access token, then send it as `Authorization: Bearer <token>` on every other route. Credentials are proxied to Supabase Auth; data access runs through PostgREST under the caller’s RLS policies.',
        version: '0.1.0',
      },
      servers: [{ url: config.server.publicUrl }],
      tags: [
        { name: 'auth', description: 'Credentials and tokens, proxied to Supabase Auth' },
        { name: 'user', description: 'The signed-in user’s profile' },
        { name: 'accounts', description: 'Budget accounts' },
        { name: 'rules', description: 'Transaction classification rules' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
      security: [{ bearerAuth: [] }],
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
