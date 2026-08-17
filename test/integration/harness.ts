import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe } from 'vitest';
import type { Database } from '../../src/supabase/database.types.js';

/**
 * Integration harness: the suite that runs against a real Postgres.
 *
 * `test/app.test.ts` proves wiring and needs no database. Everything here
 * proves *behaviour* the wiring test cannot reach — that the migration applies,
 * that the RLS policies do what their names claim, that `handle_new_user`
 * fires. Until this existed, none of `supabase/migrations/` had ever run.
 *
 * ## It skips rather than fails when the stack is absent
 *
 * `pnpm test` on a laptop without Docker, or in CI without a database, must
 * still pass. Every suite here is wrapped in `describeIntegration`, which is
 * `describe.skipIf(!stackAvailable)`.
 *
 * ## It refuses to run against anything but a local stack
 *
 * These tests create and delete users. Pointed at a hosted project that would
 * be destructive, so the probe below requires `SUPABASE_URL` to resolve to
 * loopback — a hosted URL reads as "stack absent" and skips. There is
 * deliberately no environment variable to override that.
 *
 * Bring the stack up with `pnpm db:start && pnpm db:reset`.
 */

const envFile = resolve(process.cwd(), '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const url = process.env.SUPABASE_URL ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function isLocalStack(value: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

async function isReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${url}/auth/v1/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const configured = Boolean(url && anonKey && serviceRoleKey) && isLocalStack(url);

/** True when a local Supabase stack is up and safe to write to. */
export const stackAvailable = configured && (await isReachable());

/** `describe` that skips the whole suite when there is no local stack. */
export const describeIntegration = describe.skipIf(!stackAvailable);

const clientOptions = {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
} as const;

/**
 * Service-role client. **Bypasses RLS.** Used here only to set up and tear down
 * fixtures, and to assert what a policy hides from a user client by showing the
 * row genuinely exists.
 */
export function serviceClient(): SupabaseClient<Database> {
  return createClient<Database>(url, serviceRoleKey, clientOptions);
}

/** Anonymous client — subject to RLS as an unauthenticated caller. */
export function anonClient(): SupabaseClient<Database> {
  return createClient<Database>(url, anonKey, clientOptions);
}

/** A client acting as a specific user, exactly as `createUserClient` does. */
export function userClient(accessToken: string): SupabaseClient<Database> {
  return createClient<Database>(url, anonKey, {
    ...clientOptions,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

export interface TestUser {
  id: string;
  email: string;
  accessToken: string;
  /** PostgREST client carrying this user's JWT. */
  client: SupabaseClient<Database>;
}

const createdUserIds: string[] = [];

/**
 * Sign up through GoTrue exactly as a client would, so `handle_new_user` fires
 * on a real insert into `auth.users` rather than an admin back door.
 *
 * `metadata` lands in `raw_user_meta_data`, which is what the trigger reads.
 */
export async function signUpTestUser(
  metadata: Record<string, unknown> = {},
  email = `budj-test-${randomUUID()}@example.com`,
): Promise<TestUser> {
  const anon = anonClient();
  const { data, error } = await anon.auth.signUp({
    email,
    password: `Test-${randomUUID()}`,
    options: { data: metadata },
  });

  if (error) throw new Error(`sign-up failed: ${error.message}`);
  if (!data.user || !data.session) {
    throw new Error('sign-up returned no session — is enable_confirmations off in config.toml?');
  }

  createdUserIds.push(data.user.id);

  return {
    id: data.user.id,
    email,
    accessToken: data.session.access_token,
    client: userClient(data.session.access_token),
  };
}

/**
 * Remove every user this run created. The `on delete cascade` from
 * `auth.users` takes the profile and all owned rows with it.
 */
export async function cleanupTestUsers(): Promise<void> {
  const admin = serviceClient();
  const ids = createdUserIds.splice(0);
  await Promise.all(ids.map((id) => admin.auth.admin.deleteUser(id)));
}
