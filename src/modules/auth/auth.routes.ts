import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { config } from '../../config/index.js';
import { errorResponses } from '../../lib/http.js';

const sessionResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    emailVerified: z.boolean(),
    image: z.string().nullable(),
  }),
  session: z.object({
    id: z.string(),
    expiresAt: z.coerce.string(),
  }),
});

/**
 * Everything under `/api/auth/*` is handled by better-auth itself:
 * sign-up/email, sign-in/email, sign-out, get-session, verify-email,
 * forget-password, reset-password, OAuth callbacks, …
 *
 * We forward the raw request to its WHATWG-fetch handler and copy the response
 * back onto the Fastify reply.
 */
const authRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // better-auth needs the untouched body; stop Fastify from parsing it first.
  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  fastify.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    url: '/*',
    schema: { hide: true },
    handler: async (request, reply) => {
      const url = new URL(request.url, config.auth.baseURL);

      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (Array.isArray(value)) {
          for (const entry of value) headers.append(key, entry);
        } else if (value !== undefined) {
          headers.append(key, String(value));
        }
      }

      const rawBody = Buffer.isBuffer(request.body) && request.body.length > 0 ? request.body : undefined;

      const response = await fastify.auth.handler(
        new Request(url, {
          method: request.method,
          headers,
          ...(rawBody ? { body: new Uint8Array(rawBody) } : {}),
        }),
      );

      reply.status(response.status);

      // `Headers.forEach` folds multiple Set-Cookie values into one string, which
      // breaks multi-cookie responses — pull them out separately.
      const setCookies = response.headers.getSetCookie();
      for (const [key, value] of response.headers) {
        const lower = key.toLowerCase();
        if (lower === 'set-cookie' || lower === 'content-length') continue;
        reply.header(key, value);
      }
      if (setCookies.length > 0) reply.header('set-cookie', setCookies);

      const buffer = Buffer.from(await response.arrayBuffer());
      return reply.send(buffer.length > 0 ? buffer : null);
    },
  });

  // Convenience endpoint that mirrors better-auth's session shape but shows up
  // in the OpenAPI document, unlike the catch-all above.
  fastify.get(
    '/me',
    {
      onRequest: [fastify.requireAuth],
      schema: {
        tags: ['auth'],
        summary: 'Current session',
        response: { 200: sessionResponseSchema, ...errorResponses },
      },
    },
    async (request) => ({
      user: {
        id: request.auth!.user.id,
        name: request.auth!.user.name,
        email: request.auth!.user.email,
        emailVerified: request.auth!.user.emailVerified,
        image: request.auth!.user.image ?? null,
      },
      session: {
        id: request.auth!.session.id,
        expiresAt: new Date(request.auth!.session.expiresAt).toISOString(),
      },
    }),
  );
};

export default authRoutes;
