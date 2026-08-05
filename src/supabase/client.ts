import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config/index.js';
import type { Database } from './database.types.js';

export type Supabase = SupabaseClient<Database>;

/** This is a stateless API: never persist or auto-refresh a session in the client. */
const serverAuthOptions = {
  autoRefreshToken: false,
  persistSession: false,
  detectSessionInUrl: false,
} as const;

/**
 * Anonymous key. Used for the auth proxy (sign-up, sign-in, refresh) and for
 * verifying JWTs. Subject to RLS as an unauthenticated user, so it must never be
 * used to read application tables.
 */
export function createAnonClient(): Supabase {
  return createClient<Database>(config.supabase.url, config.supabase.anonKey, {
    auth: serverAuthOptions,
  });
}

/**
 * Service role key. **Bypasses RLS entirely.**
 *
 * Only for operations that genuinely cannot run as the user — admin user
 * lookups, deleting an account. Never use it to serve a normal request; use the
 * per-request client below so the database enforces tenancy.
 */
export function createServiceClient(): Supabase {
  return createClient<Database>(config.supabase.url, config.supabase.serviceRoleKey, {
    auth: serverAuthOptions,
  });
}

/**
 * A client acting *as the signed-in user*: their access token rides on every
 * PostgREST request, so `auth.uid()` resolves and RLS policies apply. This is
 * what request handlers use.
 */
export function createUserClient(accessToken: string): Supabase {
  return createClient<Database>(config.supabase.url, config.supabase.anonKey, {
    auth: serverAuthOptions,
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  });
}
