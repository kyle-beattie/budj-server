import { env, isDevelopment, isProduction, isTest } from './env.js';

export { env, isDevelopment, isProduction, isTest };
export type { Env } from './env.js';

/** Everything served by this API lives under this prefix. */
export const API_PREFIX = '/api';

/** better-auth mounts its own routes under here (`/api/auth/*`). */
export const AUTH_PREFIX = `${API_PREFIX}/auth`;

export const config = {
  server: {
    port: env.PORT,
    host: env.HOST,
    logLevel: env.LOG_LEVEL,
  },
  database: {
    url: env.DATABASE_URL,
    ssl: env.DATABASE_SSL,
    poolMax: env.DATABASE_POOL_MAX,
  },
  auth: {
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    basePath: AUTH_PREFIX,
  },
  cors: {
    origins: env.CORS_ORIGINS,
  },
} as const;
