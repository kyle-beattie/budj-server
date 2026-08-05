import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { config, isProduction } from '../config/index.js';

/** CORS, security headers and rate limiting. */
async function securityPlugin(fastify: FastifyInstance): Promise<void> {
  await fastify.register(sensible);

  await fastify.register(helmet, {
    // The Swagger UI needs inline styles/scripts; it is disabled in production.
    contentSecurityPolicy: isProduction ? undefined : false,
    crossOriginEmbedderPolicy: false,
  });

  await fastify.register(cors, {
    origin: config.cors.origins.length > 0 ? config.cors.origins : false,
    // Tokens travel in the Authorization header, not cookies, but this keeps
    // the door open for a browser client that stores them in one.
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 86_400,
  });

  await fastify.register(rateLimit, {
    global: true,
    max: isProduction ? 300 : 10_000,
    timeWindow: '1 minute',
    // Supabase Auth applies its own, stricter limits to sign-in/sign-up on top
    // of this; a 429 from GoTrue is surfaced as RATE_LIMITED.
    keyGenerator: (request) => request.ip,
  });
}

export default fp(securityPlugin, { name: 'security' });
