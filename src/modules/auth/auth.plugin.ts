import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import fp from 'fastify-plugin';
import { UnauthorizedError } from '../../lib/errors.js';
import { createAuth, type AuthSession } from './auth.config.js';

/** Node's `IncomingHttpHeaders` -> the WHATWG `Headers` better-auth expects. */
export function toWebHeaders(nodeHeaders: FastifyRequest['headers']): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeHeaders)) {
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(key, entry);
    } else if (value !== undefined) {
      headers.append(key, String(value));
    }
  }
  return headers;
}

/**
 * Makes the better-auth instance and the route guards available application-wide.
 * `fastify-plugin` breaks encapsulation on purpose so every module can use them.
 */
async function authPlugin(fastify: FastifyInstance): Promise<void> {
  const auth = createAuth(fastify.db);

  fastify.decorate('auth', auth);
  fastify.decorateRequest('auth', null);

  async function resolveSession(request: FastifyRequest): Promise<AuthSession | null> {
    const result = await auth.api.getSession({ headers: toWebHeaders(request.headers) });
    return (result as AuthSession | null) ?? null;
  }

  /**
   * Rejects with 401 unless a valid session cookie / bearer token is present.
   * Deliberately an `onRequest` hook: it runs before schema validation, so an
   * anonymous caller gets 401 rather than a 400 that reveals the body schema.
   */
  const requireAuth: onRequestHookHandler = async (request) => {
    const session = await resolveSession(request);
    if (!session) throw new UnauthorizedError();
    request.auth = session;
  };

  /** Populates `request.auth` when a session exists, but never rejects. */
  const optionalAuth: onRequestHookHandler = async (request) => {
    request.auth = await resolveSession(request);
  };

  fastify.decorate('requireAuth', requireAuth);
  fastify.decorate('optionalAuth', optionalAuth);
}

export default fp(authPlugin, { name: 'auth', dependencies: ['db'] });
