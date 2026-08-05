import type { onRequestHookHandler } from 'fastify';
import type { Database } from '../db/index.js';
import type { Auth, AuthSession } from '../modules/auth/auth.config.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Drizzle client bound to the process-wide Postgres pool. */
    db: Database;
    /** better-auth instance. Use `fastify.auth.api.*` for credential operations. */
    auth: Auth;
    /**
     * onRequest guard that 401s unless a valid session is present.
     * Runs before body/query validation so an anonymous caller can never
     * probe a route's schema.
     */
    requireAuth: onRequestHookHandler;
    /** onRequest hook that populates `request.auth` when present, but never rejects. */
    optionalAuth: onRequestHookHandler;
  }

  interface FastifyRequest {
    /**
     * Populated by `requireAuth` / `optionalAuth`.
     * Non-null for any route guarded by `requireAuth`.
     */
    auth: AuthSession | null;
  }
}

export {};
