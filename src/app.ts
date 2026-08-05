import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { config, isDevelopment, isTest } from './config/index.js';
import type { DatabaseHandle } from './db/index.js';
import authPlugin from './modules/auth/auth.plugin.js';
import registerModules from './modules/index.js';
import dbPlugin from './plugins/db.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import healthPlugin from './plugins/health.js';
import securityPlugin from './plugins/security.js';
import swaggerPlugin from './plugins/swagger.js';

// Ambient decorator types live in ./types/fastify.d.ts and are picked up by
// tsconfig's `include` — importing it here would be a runtime import of a .d.ts.

export interface BuildAppOptions extends Partial<FastifyServerOptions> {
  /** Inject a database handle instead of opening a new pool (tests). */
  database?: DatabaseHandle;
}

/**
 * Assembles the application without binding a port, so tests can drive it with
 * `app.inject()`. Registration order matters:
 *
 *   infra (db) -> auth -> cross-cutting (security, docs, errors) -> modules
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const { database, ...serverOptions } = options;

  const app = Fastify({
    logger: isTest
      ? false
      : {
          level: config.server.logLevel,
          ...(isDevelopment
            ? {
                transport: {
                  target: 'pino-pretty',
                  options: { translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname' },
                },
              }
            : {}),
          // Never let credentials reach the log.
          redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        },
    // Render terminates TLS in front of the app.
    trustProxy: true,
    routerOptions: {
      // Collection routes are registered at the bare prefix (`/api/accounts`);
      // this makes `/api/accounts/` resolve to the same handler.
      ignoreTrailingSlash: true,
    },
    ...serverOptions,
  });

  // Zod drives both request validation and response serialization.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(errorHandlerPlugin);
  await app.register(securityPlugin);
  await app.register(dbPlugin, database ? { database } : {});
  await app.register(authPlugin);
  await app.register(healthPlugin);
  await app.register(swaggerPlugin);

  await app.register(registerModules);

  await app.ready();
  return app;
}

export default buildApp;
