import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * Load `.env` before validating. In hosted environments (Render) the variables
 * are already in `process.env`, so the file is optional by design.
 */
const envFile = resolve(process.cwd(), '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const csv = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  /** https://<project-ref>.supabase.co */
  SUPABASE_URL: z.url(),
  /** Publishable key. Safe to expose; still subject to RLS. */
  SUPABASE_ANON_KEY: z.string().min(1, 'SUPABASE_ANON_KEY is required'),
  /** Secret key. Bypasses RLS — server only, never sent to a client. */
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),

  /** Public URL this API is served from; used for auth redirect links. */
  PUBLIC_URL: z.url(),
  /**
   * Where the address-confirmation email lands. Defaults to this server's own
   * `/auth/confirm` bridge, which hands the session to the app's URL scheme.
   * Override only to move the bridge; it must be listed under Supabase's
   * Auth -> URL Configuration either way.
   */
  AUTH_CONFIRM_URL: z.url().optional(),
  /** Where Supabase sends users after a password reset. Not the bridge. */
  AUTH_REDIRECT_URL: z.url().optional(),

  CORS_ORIGINS: csv.default([]),

  /**
   * Encryption key for provider credentials at rest — the Akahu access token
   * and Apple's refresh token. `<version>:<base64 32 bytes>`, newest first:
   * `v2:...,v1:...` mid-rotation. See `src/lib/token-crypto.ts`.
   *
   * Losing this orphans every stored token and forces every user to reconnect
   * their bank. It belongs in Render's secret store, not in a repository.
   */
  TOKEN_ENC_KEY: z.string().min(1, 'TOKEN_ENC_KEY is required'),

  // ---- Sign in with Apple ---------------------------------------------------
  // Used only to exchange the authorization code captured at sign-in for a
  // refresh token, so the account can be revoked with Apple at deletion. This
  // is NOT the App Store Connect key — that is a separate credential.
  /** Apple Developer team identifier (`iss` of the client secret). */
  APPLE_TEAM_ID: z.string().min(1, 'APPLE_TEAM_ID is required'),
  /** Key identifier for the Sign in with Apple `.p8` (`kid` of the client secret). */
  APPLE_KEY_ID: z.string().min(1, 'APPLE_KEY_ID is required'),
  /**
   * Contents of the `.p8`, PEM encoded. Newlines may be written as literal
   * `\n`, which is the only way most secret stores accept a multi-line value.
   *
   * Apple expires this key every six months and the code exchange fails
   * silently when it lapses — see the runbook.
   */
  APPLE_PRIVATE_KEY: z
    .string()
    .min(1, 'APPLE_PRIVATE_KEY is required')
    .transform((value) => value.replace(/\\n/g, '\n')),
  /** The app's bundle identifier — the `sub` of the client secret. */
  APPLE_CLIENT_ID: z.string().min(1, 'APPLE_CLIENT_ID is required'),

  // ---- App Store Connect / StoreKit -----------------------------------------
  // A **different** credential from the Sign in with Apple key above. Used to
  // call the App Store Server API. Notification and transaction verification
  // needs none of it — that is a certificate chain to Apple's pinned root — so
  // these are only required once the server calls Apple rather than the reverse.
  /** Issuer id from App Store Connect → Users and Access → Integrations. */
  APP_STORE_ISSUER_ID: z.string().min(1, 'APP_STORE_ISSUER_ID is required'),
  /** Key id of the App Store Connect API `.p8`. */
  APP_STORE_KEY_ID: z.string().min(1, 'APP_STORE_KEY_ID is required'),
  /** Contents of the App Store Connect `.p8`, PEM encoded. Literal `\n` allowed. */
  APP_STORE_PRIVATE_KEY: z
    .string()
    .min(1, 'APP_STORE_PRIVATE_KEY is required')
    .transform((value) => value.replace(/\\n/g, '\n')),
  /** Bundle id the app ships under; asserted against what Apple signs. */
  APP_STORE_BUNDLE_ID: z.string().min(1, 'APP_STORE_BUNDLE_ID is required'),
  /** The app's numeric Apple id. */
  APP_STORE_APP_APPLE_ID: z.string().min(1, 'APP_STORE_APP_APPLE_ID is required'),
  /**
   * Which App Store environment this deployment trusts. Sandbox and production
   * sign with different chains and carry different transaction ids; accepting
   * both would let a sandbox purchase entitle a production account.
   */
  APP_STORE_ENVIRONMENT: z.enum(['Sandbox', 'Production']).default('Sandbox'),

  // ---- Akahu -----------------------------------------------------------------
  /** App ID Token (`app_token_...`). Identifies this application to Akahu. */
  AKAHU_APP_TOKEN: z.string().min(1, 'AKAHU_APP_TOKEN is required'),
  /** App Secret. Pairs with the app token to start and complete authorisation. */
  AKAHU_APP_SECRET: z.string().min(1, 'AKAHU_APP_SECRET is required'),
  /**
   * Where Akahu sends the user after they authorise. **Must be registered with
   * Akahu** and match byte-for-byte, including trailing slash — a mismatch
   * fails the code exchange rather than the redirect, which makes it look like
   * a token problem.
   */
  AKAHU_REDIRECT_URI: z.url(),

  // ---- Client version gating (D15) -------------------------------------------
  /**
   * Lowest iOS build allowed to call the API. Unset disables the gate, which is
   * fine locally and is refused in production below — "forgot to configure it"
   * must not silently mean "no gating".
   */
  MIN_SUPPORTED_BUILD: z.coerce.number().int().positive().optional(),
  /**
   * Inclusive build range refused for money movement only, e.g. `412-418`.
   * Kept separate from the minimum: killing an entire client version because
   * its amount handling is wrong is worse than refusing the operations that
   * depend on it. Environment, not a table — this changes during an incident.
   */
  BLOCKED_MONEY_BUILDS: z
    .string()
    .regex(/^\d{1,10}-\d{1,10}$/, 'Expected a range like 412-418')
    .optional(),
});

export type Env = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env: Env = parsed.data;

/**
 * A production deployment with no minimum build has no version gate at all, and
 * the failure is invisible until the day a bad build needs stopping. Fail at
 * boot instead.
 */
if (env.NODE_ENV === 'production' && env.MIN_SUPPORTED_BUILD === undefined) {
  throw new Error(
    'MIN_SUPPORTED_BUILD is required in production: without it no client version can ever be gated.',
  );
}

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const isDevelopment = env.NODE_ENV === 'development';
