import type { onRequestHookHandler } from 'fastify';
import type { Supabase } from '../supabase/client.js';
import type { AuthContext } from '../modules/auth/auth.plugin.js';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Anon-key client. Used for the auth proxy and JWT verification.
     * Subject to RLS as an unauthenticated user — never read app tables with it.
     */
    supabaseAnon: Supabase;
    /**
     * Service-role client. **Bypasses RLS.** Admin operations only, never to
     * serve a normal request.
     */
    supabaseAdmin: Supabase;
    /**
     * onRequest guard that 401s unless a valid Supabase access token is present.
     * Runs before body/query validation so an anonymous caller can never probe
     * a route's schema. Populates `request.auth` and `request.supabase`.
     */
    requireAuth: onRequestHookHandler;
    /** onRequest hook that populates `request.auth` when present, but never rejects. */
    optionalAuth: onRequestHookHandler;
  }

  interface FastifyRequest {
    /** Verified JWT claims. Non-null on any route guarded by `requireAuth`. */
    auth: AuthContext | null;
    /**
     * Supabase client bound to the caller's access token, so `auth.uid()`
     * resolves and RLS applies. Non-null wherever `request.auth` is.
     */
    supabase: Supabase | null;
  }
}

export {};
