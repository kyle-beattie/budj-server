import closeWithGrace from 'close-with-grace';
import { buildApp } from './app.js';
import { config } from './config/index.js';

async function main(): Promise<void> {
  const app = await buildApp();

  closeWithGrace({ delay: 10_000 }, async ({ err, signal }) => {
    if (err) app.log.error({ err }, 'shutting down after an unhandled error');
    else app.log.info({ signal }, 'shutting down');
    await app.close();
  });

  await app.listen({ port: config.server.port, host: config.server.host });
}

main().catch((error) => {
  console.error('failed to start server:', error);
  process.exit(1);
});
