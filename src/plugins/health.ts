import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { sql } from 'drizzle-orm';

/** Liveness and readiness probes. Render polls `/healthz`. */
async function healthPlugin(fastify: FastifyInstance): Promise<void> {
  fastify.get('/healthz', { schema: { hide: true } }, async () => ({
    status: 'ok',
    uptime: Math.round(process.uptime()),
  }));

  fastify.get('/readyz', { schema: { hide: true } }, async (_request, reply) => {
    try {
      await fastify.db.execute(sql`select 1`);
      return { status: 'ready' };
    } catch (error) {
      fastify.log.error({ err: error }, 'readiness check failed');
      return reply.status(503).send({ status: 'unavailable' });
    }
  });
}

export default fp(healthPlugin, { name: 'health', dependencies: ['db'] });
