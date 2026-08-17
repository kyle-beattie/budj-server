import type { onRequestHookHandler } from 'fastify';
import type { Supabase } from '../supabase/client.js';
import type { AuthContext } from '../modules/auth/auth.plugin.js';
import type { Plan } from '../modules/billing/plans.js';

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
    /**
     * onRequest guard that 402s unless the caller has an active subscription.
     * Must be registered **after** `requireAuth`. Populates `request.entitlements`.
     *
     * Deliberately absent from onboarding status, the plan catalogue and
     * purchase submission — you cannot require a subscription to buy one.
     */
    requireSubscription: onRequestHookHandler;
    /**
     * onRequest guard that refuses money movement from a client build listed as
     * blocked, while leaving every other operation available.
     *
     * Nothing initiates a payment in this change, so nothing applies it yet —
     * it exists, and is proven to refuse, so `add-rule-triggers` inherits a
     * working gate rather than building one during an incident.
     */
    requireMoneyMovementAllowed: onRequestHookHandler;
  }

  interface FastifyRequest {
    /** Verified JWT claims. Non-null on any route guarded by `requireAuth`. */
    auth: AuthContext | null;
    /**
     * Supabase client bound to the caller's access token, so `auth.uid()`
     * resolves and RLS applies. Non-null wherever `request.auth` is.
     */
    supabase: Supabase | null;
    /**
     * Limits and effects the caller's plan grants, resolved from the code
     * catalogue. Non-null on any route guarded by `requireSubscription`.
     */
    entitlements: Plan | null;
    /**
     * The caller's client build, from `x-client-build`. Null on exempt routes
     * (webhooks, health, docs) and when the version gate is disabled.
     */
    clientBuild: number | null;
  }
}

export {};
