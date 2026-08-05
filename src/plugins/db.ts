import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { createDatabase, type Database, type DatabaseHandle } from '../db/index.js';

export interface DbPluginOptions {
  /**
   * Pre-built handle, for tests that supply their own pool or a stub.
   * When provided, this plugin will not open or close it.
   */
  database?: DatabaseHandle;
}

/**
 * Owns the single Postgres pool for the process and tears it down on close.
 * Everything else reads `fastify.db`.
 */
async function dbPlugin(fastify: FastifyInstance, options: DbPluginOptions): Promise<void> {
  if (options.database) {
    fastify.decorate('db', options.database.db);
    return;
  }

  const { db, pool, close } = createDatabase();

  // Fail fast on boot rather than on the first request.
  await pool.query('select 1');
  fastify.log.info('database connection established');

  fastify.decorate('db', db as Database);

  fastify.addHook('onClose', async () => {
    await close();
    fastify.log.info('database pool closed');
  });
}

export default fp(dbPlugin, { name: 'db' });
