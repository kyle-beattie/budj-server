import { parseKeyring } from '../lib/token-crypto.js';
import { env, isDevelopment, isProduction, isTest } from './env.js';

export { env, isDevelopment, isProduction, isTest };
export type { Env } from './env.js';

/** Everything served by this API lives under this prefix. */
export const API_PREFIX = '/api';

/** The auth proxy in front of Supabase Auth. */
export const AUTH_PREFIX = `${API_PREFIX}/auth`;

/**
 * The address-confirmation bridge. Deliberately outside `/api`: it is opened by
 * a browser following a link from an email, not by the app, and it answers HTML.
 */
export const AUTH_BRIDGE_PREFIX = '/auth';
export const AUTH_CONFIRM_PATH = `${AUTH_BRIDGE_PREFIX}/confirm`;

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function parseBuildRange(raw: string | undefined): { from: number; to: number } | null {
  if (!raw) return null;
  const [from, to] = raw.split('-').map(Number) as [number, number];
  // Written the wrong way round is a typo during an incident, not a config to
  // honour literally.
  return from <= to ? { from, to } : { from: to, to: from };
}

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
    /**
     * Where the address-confirmation email lands: the bridge, which hands the
     * session to the app's URL scheme (D17 in `add-ios-onboarding`). Defaults to
     * this server's own route, so the flow works without anything being
     * configured — and an override still has to be listed under Supabase's
     * Auth -> URL Configuration to be honoured.
     */
    confirmUrl: env.AUTH_CONFIRM_URL ?? `${trimTrailingSlash(env.PUBLIC_URL)}${AUTH_CONFIRM_PATH}`,
    /**
     * Password reset, which is **not** the bridge and must not become it. A
     * recovery link also returns a session, so pointing it at the confirmation
     * hand-off would sign someone in and tell them their email was confirmed
     * when what they asked for was a new password. There is no reset screen in
     * the app yet; until there is, this stays where it was.
     */
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
  /** App Store Connect — a separate credential from `apple` above. */
  appStore: {
    issuerId: env.APP_STORE_ISSUER_ID,
    keyId: env.APP_STORE_KEY_ID,
    privateKey: env.APP_STORE_PRIVATE_KEY,
    bundleId: env.APP_STORE_BUNDLE_ID,
    appAppleId: env.APP_STORE_APP_APPLE_ID,
    environment: env.APP_STORE_ENVIRONMENT,
  },
  client: {
    minimumBuild: env.MIN_SUPPORTED_BUILD ?? null,
    blockedMoneyBuilds: parseBuildRange(env.BLOCKED_MONEY_BUILDS),
  },
  akahu: {
    appToken: env.AKAHU_APP_TOKEN,
    appSecret: env.AKAHU_APP_SECRET,
    redirectUri: env.AKAHU_REDIRECT_URI,
  },
} as const;
