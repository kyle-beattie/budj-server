import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponses } from '../../lib/http.js';
import { createUserClient } from '../../supabase/index.js';
import { AuthService } from './auth.service.js';
import {
  currentUserSchema,
  refreshSchema,
  requestPasswordResetSchema,
  sessionSchema,
  signInSchema,
  signUpSchema,
  signUpResponseSchema,
  updatePasswordSchema,
} from './auth.types.js';

const acceptedSchema = z.object({ status: z.literal('accepted') });

/**
 * Credential endpoints, proxied to Supabase Auth. No password or token is
 * generated here — see auth.service.ts.
 *
 * Tokens are returned in the response body rather than set as cookies, so
 * native and server-side clients work without a cookie jar. Clients send
 * `Authorization: Bearer <accessToken>` on subsequent requests.
 */
const authRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const service = new AuthService(fastify.supabaseAnon, fastify.supabaseAdmin);

  fastify.post(
    '/sign-up',
    {
      schema: {
        tags: ['auth'],
        summary: 'Create an account',
        description:
          'If email confirmation is enabled on the Supabase project, no session is returned until the address is confirmed.',
        body: signUpSchema,
        response: { 201: signUpResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => reply.status(201).send(await service.signUp(request.body)),
  );

  fastify.post(
    '/sign-in',
    {
      schema: {
        tags: ['auth'],
        summary: 'Exchange email and password for a session',
        body: signInSchema,
        response: { 200: sessionSchema, ...errorResponses },
      },
    },
    async (request) => service.signIn(request.body),
  );

  fastify.post(
    '/refresh',
    {
      schema: {
        tags: ['auth'],
        summary: 'Exchange a refresh token for a new session',
        body: refreshSchema,
        response: { 200: sessionSchema, ...errorResponses },
      },
    },
    async (request) => service.refresh(request.body),
  );

  fastify.post(
    '/sign-out',
    {
      onRequest: [fastify.requireAuth],
      schema: {
        tags: ['auth'],
        summary: 'Revoke the caller’s tokens',
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      await service.signOut(request.auth!.accessToken);
      return reply.status(204).send(null);
    },
  );

  fastify.post(
    '/password/reset',
    {
      schema: {
        tags: ['auth'],
        summary: 'Send a password reset email',
        description:
          'Always returns 202, whether or not the address is registered — this must not be usable to enumerate accounts.',
        body: requestPasswordResetSchema,
        response: { 202: acceptedSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      await service.requestPasswordReset(request.body.email);
      return reply.status(202).send({ status: 'accepted' as const });
    },
  );

  fastify.post(
    '/password',
    {
      onRequest: [fastify.requireAuth],
      schema: {
        tags: ['auth'],
        summary: 'Change the signed-in user’s password',
        body: updatePasswordSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      // Must run as the user: updateUser acts on whoever the token belongs to.
      await service.updatePassword(createUserClient(request.auth!.accessToken), request.body.password);
      return reply.status(204).send(null);
    },
  );

  fastify.get(
    '/me',
    {
      onRequest: [fastify.requireAuth],
      schema: {
        tags: ['auth'],
        summary: 'Identity carried by the current access token',
        description: 'Verified JWT claims only. For the editable profile use GET /api/users/me.',
        response: { 200: currentUserSchema, ...errorResponses },
      },
    },
    async (request) => ({
      id: request.auth!.userId,
      email: request.auth!.email,
      role: request.auth!.role,
    }),
  );
};

export default authRoutes;
