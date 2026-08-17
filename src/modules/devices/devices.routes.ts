import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponses } from '../../lib/http.js';
import { DevicesRepository } from './devices.repository.js';
import { DevicesService } from './devices.service.js';
import {
  deviceIdParamSchema,
  deviceListSchema,
  deviceSchema,
  registerDeviceSchema,
} from './devices.types.js';

function serviceFor(request: FastifyRequest): DevicesService {
  return new DevicesService(new DevicesRepository(request.supabase!));
}

const devicesRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.addHook('onRequest', fastify.requireAuth);
  // Past the paywall like everything else beyond identity. Push only matters
  // for rule approvals, which are themselves gated.
  fastify.addHook('onRequest', fastify.requireSubscription);

  fastify.post(
    '',
    {
      schema: {
        tags: ['devices'],
        summary: 'Register a device for push notifications',
        description:
          'Upserts on (user, device). Re-registering replaces the stored APNs token, which is routine — APNs reissues tokens.',
        body: registerDeviceSchema,
        response: { 200: deviceSchema, ...errorResponses },
      },
    },
    async (request) => serviceFor(request).register(request.auth!.userId, request.body),
  );

  fastify.get(
    '',
    {
      schema: {
        tags: ['devices'],
        summary: 'List the current user’s registered devices',
        response: { 200: deviceListSchema, ...errorResponses },
      },
    },
    async (request) => ({ data: await serviceFor(request).list(request.auth!.userId) }),
  );

  fastify.delete(
    '/:deviceId',
    {
      schema: {
        tags: ['devices'],
        summary: 'Revoke a device registration',
        description: 'Marks the registration revoked rather than deleting it.',
        params: deviceIdParamSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      await serviceFor(request).revoke(request.auth!.userId, request.params.deviceId);
      return reply.status(204).send(null);
    },
  );
};

export default devicesRoutes;
