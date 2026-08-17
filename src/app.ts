import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { config, isDevelopment, isTest } from './config/index.js';
import authPlugin from './modules/auth/auth.plugin.js';
import billingPlugin from './modules/billing/billing.plugin.js';
import clientVersionPlugin from './plugins/client-version.js';
import registerModules from './modules/index.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import healthPlugin from './plugins/health.js';
import securityPlugin from './plugins/security.js';
import swaggerPlugin from './plugins/swagger.js';

// Ambient decorator types live in ./types/fastify.d.ts and are picked up by
// tsconfig's `include` — importing it here would be a runtime import of a .d.ts.

export type BuildAppOptions = Partial<FastifyServerOptions>;

/**
 * Assembles the application without binding a port, so tests can drive it with
 * `app.inject()`. Registration order matters:
 *
 *   errors -> security -> client version -> auth (Supabase clients + guards)
 *   -> billing (the entitlement gate) -> health -> docs -> modules
 *
 * There is no database plugin: this API reaches Postgres through PostgREST, and
 * every request builds its own client from the caller's token.
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
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
          redact: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.body.password',
            'req.body.refreshToken',
          ],
        },
    // Render terminates TLS in front of the app.
    trustProxy: true,
    routerOptions: {
      // Collection routes are registered at the bare prefix (`/api/accounts`);
      // this makes `/api/accounts/` resolve to the same handler.
      ignoreTrailingSlash: true,
    },
    ...options,
  });

  // Zod drives both request validation and response serialization.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(errorHandlerPlugin);
  await app.register(securityPlugin);
  // Before auth: an unsupported build should be told to update rather than to
  // sign in, and the check costs nothing.
  await app.register(clientVersionPlugin, config.client);
  await app.register(authPlugin);
  // Decorates `requireSubscription`; depends on auth for `request.auth`.
  await app.register(billingPlugin);
  await app.register(healthPlugin);
  await app.register(swaggerPlugin);

  await app.register(registerModules);

  await app.ready();
  return app;
}

export default buildApp;
