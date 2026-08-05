import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { config } from '../config/index.js';
import * as schema from './schema.js';

const { Pool } = pg;

export type Schema = typeof schema;
export type Database = NodePgDatabase<Schema>;

export interface DatabaseHandle {
  db: Database;
  pool: pg.Pool;
  close: () => Promise<void>;
}

/**
 * Postgres `numeric` columns come back as strings by default, which is correct
 * for money. We keep that behaviour and convert at the service boundary.
 */
export function createDatabase(connectionString = config.database.url): DatabaseHandle {
  const pool = new Pool({
    connectionString,
    max: config.database.poolMax,
    // Render's external connection string requires TLS; the internal one does not.
    ssl: config.database.ssl ? { rejectUnauthorized: false } : false,
  });

  const db = drizzle(pool, { schema, casing: 'snake_case' });

  return {
    db,
    pool,
    close: async () => {
      await pool.end();
    },
  };
}

export { schema };
