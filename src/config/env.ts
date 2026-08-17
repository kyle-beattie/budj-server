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
  /** Where Supabase sends users after email confirmation / password reset. */
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

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const isDevelopment = env.NODE_ENV === 'development';
