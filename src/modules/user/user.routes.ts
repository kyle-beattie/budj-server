import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { errorResponses } from '../../lib/http.js';
import { UserRepository } from './user.repository.js';
import { UserService } from './user.service.js';
import { updateUserProfileSchema, userProfileSchema } from './user.types.js';

const userRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const service = new UserService(new UserRepository(fastify.db));

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
    async (request) => service.getProfile(request.auth!.user.id),
  );

  fastify.patch(
    '/me',
    {
      schema: {
        tags: ['user'],
        summary: 'Update the signed-in user’s profile',
        description:
          'Only non-credential fields. Change email or password via POST /api/auth/change-email and /api/auth/change-password.',
        body: updateUserProfileSchema,
        response: { 200: userProfileSchema, ...errorResponses },
      },
    },
    async (request) => service.updateProfile(request.auth!.user.id, request.body),
  );
};

export default userRoutes;
