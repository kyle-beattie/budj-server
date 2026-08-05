import type { FastifyError, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import { isProduction } from '../config/index.js';
import { isAppError, NotFoundError } from '../lib/errors.js';
import type { ErrorResponse } from '../lib/http.js';

/** The single place errors become HTTP responses. */
async function errorHandlerPlugin(fastify: FastifyInstance): Promise<void> {
  fastify.setNotFoundHandler((request, reply) => {
    const error = new NotFoundError(`Route ${request.method} ${request.url}`);
    const body: ErrorResponse = { error: { code: error.code, message: error.message } };
    return reply.status(404).send(body);
  });

  fastify.setErrorHandler((error, request, reply) => {
    // Request failed schema validation.
    if (hasZodFastifySchemaValidationErrors(error)) {
      request.log.info({ err: error }, 'request validation failed');
      const body: ErrorResponse = {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request does not match the expected schema',
          details: error.validation.map((issue) => ({
            path: issue.instancePath,
            message: issue.message,
          })),
        },
      };
      return reply.status(400).send(body);
    }

    // We produced a response that doesn't match our own contract — always a bug.
    if (isResponseSerializationError(error)) {
      request.log.error({ err: error }, 'response serialization failed');
      const body: ErrorResponse = {
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
      };
      return reply.status(500).send(body);
    }

    if (isAppError(error)) {
      const level = error.statusCode >= 500 ? 'error' : 'info';
      request.log[level]({ err: error }, error.message);
      const body: ErrorResponse = {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      };
      return reply.status(error.statusCode).send(body);
    }

    // Anything thrown by Fastify itself (rate limit, payload too large, …).
    // The type guards above erase the declared type, so restate it here.
    const fastifyError = error as FastifyError;
    const statusCode = fastifyError.statusCode ?? 500;

    if (statusCode < 500) {
      request.log.info({ err: fastifyError }, fastifyError.message);
      const body: ErrorResponse = {
        error: { code: fastifyError.code ?? 'BAD_REQUEST', message: fastifyError.message },
      };
      return reply.status(statusCode).send(body);
    }

    request.log.error({ err: fastifyError }, 'unhandled error');
    const body: ErrorResponse = {
      error: {
        code: 'INTERNAL_ERROR',
        // Never leak internals in production.
        message: isProduction ? 'Internal server error' : fastifyError.message,
      },
    };
    return reply.status(500).send(body);
  });
}

export default fp(errorHandlerPlugin, { name: 'error-handler' });
