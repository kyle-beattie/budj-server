import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

/** Liveness and readiness probes. Render polls `/healthz`. */
async function healthPlugin(fastify: FastifyInstance): Promise<void> {
  fastify.get('/healthz', { schema: { hide: true } }, async () => ({
    status: 'ok',
    uptime: Math.round(process.uptime()),
  }));

  fastify.get('/readyz', { schema: { hide: true } }, async (_request, reply) => {
    try {
      // Cheapest round trip that proves PostgREST is reachable and the anon key
      // is valid. `head` fetches no rows; RLS makes the count 0 for anon, which
      // is fine — we only care that the request succeeded.
      const { error } = await fastify.supabaseAnon
        .from('profiles')
        .select('id', { head: true, count: 'exact' });

      if (error) throw error;
      return { status: 'ready' };
    } catch (error) {
      fastify.log.error({ err: error }, 'readiness check failed');
      return reply.status(503).send({ status: 'unavailable' });
    }
  });
}

export default fp(healthPlugin, { name: 'health', dependencies: ['auth'] });
