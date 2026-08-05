import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase } from './index.js';

/**
 * Applies pending migrations from ./drizzle and exits.
 *
 *   local:  npm run db:migrate
 *   Render: npm run db:migrate:prod   (wired to preDeployCommand in render.yaml)
 *
 * Uses drizzle-orm's runtime migrator rather than the drizzle-kit CLI so it
 * works from the built output without devDependencies installed.
 */
async function main(): Promise<void> {
  const { db, close } = createDatabase();
  try {
    console.log('applying migrations…');
    await migrate(db, { migrationsFolder: 'drizzle' });
    console.log('migrations up to date');
  } finally {
    await close();
  }
}

main().catch((error) => {
  console.error('migration failed:', error);
  process.exit(1);
});
