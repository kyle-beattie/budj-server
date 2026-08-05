import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { errorResponses } from '../../lib/http.js';
import { UserRepository } from './user.repository.js';
import { UserService } from './user.service.js';
import { updateUserProfileSchema, userProfileSchema } from './user.types.js';

/**
 * Built per request, not once at registration: the Supabase client carries the
 * caller's access token so PostgREST applies their RLS policies.
 */
function serviceFor(request: FastifyRequest): UserService {
  return new UserService(new UserRepository(request.supabase!));
}

const userRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.addHook('onRequest', fastify.requireAuth);

  fastify.get(
    '/me',
    {
      schema: {
        tags: ['user'],
        summary: 'Fetch the signed-in user’s profile',
        response: { 200: userProfileSchema, ...errorResponses },
      },
    },
    async (request) => serviceFor(request).getProfile(request.auth!.userId, request.auth!.email),
  );

  fastify.patch(
    '/me',
    {
      schema: {
        tags: ['user'],
        summary: 'Update the signed-in user’s profile',
        description:
          'Only non-credential fields. Change password via POST /api/auth/password; email is managed by Supabase Auth.',
        body: updateUserProfileSchema,
        response: { 200: userProfileSchema, ...errorResponses },
      },
    },
    async (request) =>
      serviceFor(request).updateProfile(request.auth!.userId, request.auth!.email, request.body),
  );
};

export default userRoutes;
