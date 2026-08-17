import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponses } from '../../lib/http.js';
import { createUserClient } from '../../supabase/index.js';
import { AppleGrantRepository } from './apple.repository.js';
import { AppleGrantService } from './apple.service.js';
import { AuthService } from './auth.service.js';
import {
  appleGrantResultSchema,
  appleGrantSchema,
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

  /**
   * The only provider endpoint on this server, and it deliberately accepts an
   * authorization *code* rather than an identity token — identity tokens go
   * straight from the app to Supabase and are never seen here (D2).
   *
   * Requires a session: the app calls this immediately after
   * `signInWithIdToken`, so the code is bound to a user this server has already
   * verified rather than to whatever the request body claims.
   */
  fastify.post(
    '/apple/grant',
    {
      onRequest: [fastify.requireAuth],
      schema: {
        tags: ['auth'],
        summary: 'Store Apple’s authorization code grant for later revocation',
        description:
          'Exchanges Apple’s single-use authorization code for a refresh token and stores it encrypted, so the account can be revoked with Apple on deletion. The code expires in about five minutes and cannot be replayed, so it must be sent during sign-in. Returns 200 even when the exchange fails — the caller is already signed in and there is nothing to retry.',
        body: appleGrantSchema,
        response: { 200: appleGrantResultSchema, ...errorResponses },
      },
    },
    async (request) =>
      new AppleGrantService(
        // Service role: apple_grants has deny-all RLS and is withheld from
        // `authenticated`, so a user client cannot write it (D4/D5).
        new AppleGrantRepository(fastify.supabaseAdmin),
        request.log,
      ).capture(request.auth!.userId, request.body.authorizationCode),
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
