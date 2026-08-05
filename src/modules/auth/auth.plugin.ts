import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import fp from 'fastify-plugin';
import { UnauthorizedError } from '../../lib/errors.js';
import { createAnonClient, createServiceClient, createUserClient } from '../../supabase/index.js';

export interface AuthContext {
  /** Supabase user id (the JWT `sub`). Foreign key for every owned row. */
  userId: string;
  email: string | null;
  role: string | null;
  /** The raw access token, forwarded to PostgREST so RLS sees this user. */
  accessToken: string;
}

function extractBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') return null;
  return token.trim() || null;
}

/**
 * Verifies Supabase access tokens and hands each request a client bound to the
 * caller's identity.
 *
 * `fastify-plugin` breaks encapsulation on purpose so every module can use the
 * guards.
 */
async function authPlugin(fastify: FastifyInstance): Promise<void> {
  // Used for JWT verification and the auth proxy. Subject to RLS.
  const anon = createAnonClient();
  // Bypasses RLS. Admin operations only.
  const service = createServiceClient();

  fastify.decorate('supabaseAnon', anon);
  fastify.decorate('supabaseAdmin', service);
  fastify.decorateRequest('auth', null);
  fastify.decorateRequest('supabase', null);

  /**
   * `getClaims` verifies the signature locally against the project's JWKS
   * (cached in the client), so this costs no network round trip per request
   * once warm. It falls back to a call to the auth server for legacy symmetric
   * (HS256) projects.
   */
  async function resolveAuth(request: FastifyRequest): Promise<AuthContext | null> {
    const accessToken = extractBearerToken(request);
    if (!accessToken) return null;

    const { data, error } = await anon.auth.getClaims(accessToken);
    if (error || !data?.claims?.sub) {
      if (error) request.log.debug({ err: error }, 'token verification failed');
      return null;
    }

    const { claims } = data;
    return {
      userId: claims.sub,
      email: typeof claims.email === 'string' ? claims.email : null,
      role: typeof claims.role === 'string' ? claims.role : null,
      accessToken,
    };
  }

  /**
   * Rejects with 401 unless a valid access token is present.
   *
   * Deliberately an `onRequest` hook: it runs before schema validation, so an
   * anonymous caller gets 401 rather than a 400 that reveals the body schema.
   */
  const requireAuth: onRequestHookHandler = async (request) => {
    const auth = await resolveAuth(request);
    if (!auth) throw new UnauthorizedError();
    request.auth = auth;
    // Every query this request makes now runs as the user, under RLS.
    request.supabase = createUserClient(auth.accessToken);
  };

  /** Populates `request.auth` when a token is present, but never rejects. */
  const optionalAuth: onRequestHookHandler = async (request) => {
    const auth = await resolveAuth(request);
    request.auth = auth;
    request.supabase = auth ? createUserClient(auth.accessToken) : null;
  };

  fastify.decorate('requireAuth', requireAuth);
  fastify.decorate('optionalAuth', optionalAuth);
}

export default fp(authPlugin, { name: 'auth' });
