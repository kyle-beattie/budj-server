import { parseKeyring } from '../lib/token-crypto.js';
import { env, isDevelopment, isProduction, isTest } from './env.js';

export { env, isDevelopment, isProduction, isTest };
export type { Env } from './env.js';

/** Everything served by this API lives under this prefix. */
export const API_PREFIX = '/api';

/** The auth proxy in front of Supabase Auth. */
export const AUTH_PREFIX = `${API_PREFIX}/auth`;

export const config = {
  server: {
    port: env.PORT,
    host: env.HOST,
    logLevel: env.LOG_LEVEL,
    publicUrl: env.PUBLIC_URL,
  },
  supabase: {
    url: env.SUPABASE_URL,
    anonKey: env.SUPABASE_ANON_KEY,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  },
  auth: {
    /** Passed to Supabase as emailRedirectTo for confirmation and reset links. */
    redirectUrl: env.AUTH_REDIRECT_URL ?? env.PUBLIC_URL,
  },
  cors: {
    origins: env.CORS_ORIGINS,
  },
  /**
   * Parsed once, at import, so a malformed key is a startup failure with a
   * readable message rather than a 500 the first time someone connects a bank.
   */
  tokenCrypto: {
    keyring: parseKeyring(env.TOKEN_ENC_KEY),
  },
  apple: {
    teamId: env.APPLE_TEAM_ID,
    keyId: env.APPLE_KEY_ID,
    privateKey: env.APPLE_PRIVATE_KEY,
    clientId: env.APPLE_CLIENT_ID,
  },
} as const;
