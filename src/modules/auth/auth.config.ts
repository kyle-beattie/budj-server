import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { config, isProduction } from '../../config/index.js';
import type { Database } from '../../db/index.js';
import { account, session, user, verification } from './auth.schema.js';

const DAY = 60 * 60 * 24;

/**
 * better-auth owns every credential/session concern. Nothing in this codebase
 * should hash a password or mint a session token by hand — go through `auth.api`.
 */
export function createAuth(db: Database) {
  return betterAuth({
    appName: 'budj',
    baseURL: config.auth.baseURL,
    basePath: config.auth.basePath,
    secret: config.auth.secret,

    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: { user, session, account, verification },
    }),

    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      autoSignIn: true,
      // TODO: wire a transactional email provider, then flip this on.
      requireEmailVerification: false,
    },

    // Add providers here as they are configured, e.g.
    // socialProviders: { google: { clientId: ..., clientSecret: ... } },

    session: {
      expiresIn: 30 * DAY,
      updateAge: 1 * DAY,
      // Signed short-lived cookie so most requests skip the session table read.
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },

    advanced: {
      useSecureCookies: isProduction,
      defaultCookieAttributes: {
        sameSite: isProduction ? 'none' : 'lax',
        secure: isProduction,
        httpOnly: true,
      },
    },

    // Browser origins allowed to complete auth flows against this API.
    trustedOrigins: [config.auth.baseURL, ...config.cors.origins],

    rateLimit: { enabled: isProduction },
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type AuthSession = Auth['$Infer']['Session'];
export type AuthUser = AuthSession['user'];
