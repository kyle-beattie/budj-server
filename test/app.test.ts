import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { DatabaseHandle } from '../src/db/index.js';

/**
 * Wiring test: no Postgres required. It proves the plugin graph assembles, every
 * module mounts where the registry says it does, guards reject anonymous callers
 * and the Zod schemas produce a valid OpenAPI document.
 *
 * Behaviour that touches the database belongs in an integration suite pointed at
 * a real DATABASE_URL.
 */
const stubDatabase = {
  db: {} as DatabaseHandle['db'],
  pool: {} as DatabaseHandle['pool'],
  close: async () => {},
} satisfies DatabaseHandle;

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ database: stubDatabase });
});

afterAll(async () => {
  await app.close();
});

describe('health', () => {
  it('reports liveness without touching the database', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
  });
});

describe('module mounting', () => {
  it.each([
    ['GET', '/api/users/me'],
    ['PATCH', '/api/users/me'],
    ['GET', '/api/accounts'],
    ['POST', '/api/accounts'],
    ['GET', '/api/rules'],
    ['POST', '/api/rules'],
    ['POST', '/api/rules/evaluate'],
    ['GET', '/api/auth/me'],
  ])('%s %s exists and rejects anonymous callers with 401', async (method, url) => {
    const response = await app.inject({ method: method as 'GET', url });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });

  it('routes /api/auth/* to better-auth rather than the 404 handler', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auth/get-session' });
    // better-auth answers with 200 + null body when there is no session.
    expect(response.statusCode).toBeLessThan(500);
    expect(response.statusCode).not.toBe(404);
  });
});

describe('error handling', () => {
  it('returns the standard envelope for unknown routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});

describe('openapi', () => {
  it('generates a document covering every module', async () => {
    const document = app.swagger() as { paths: Record<string, unknown> };
    const paths = Object.keys(document.paths);

    expect(paths).toContain('/api/users/me');
    expect(paths).toContain('/api/accounts');
    expect(paths).toContain('/api/accounts/{id}');
    expect(paths).toContain('/api/rules');
    expect(paths).toContain('/api/rules/evaluate');
    // The better-auth catch-all is hidden; the documented /me endpoint is not.
    expect(paths).toContain('/api/auth/me');
  });
});
