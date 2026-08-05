import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

/**
 * Wiring test: no Supabase project required.
 *
 * Guarded routes reject before any network call, because `requireAuth` fails on
 * a missing/!malformed Authorization header without reaching the auth server.
 * That is enough to prove the plugin graph assembles, every module mounts where
 * the registry says, the guards run in the right hook, and the Zod schemas
 * produce a valid OpenAPI document.
 *
 * Anything that needs a real token or real rows belongs in an integration suite
 * pointed at a Supabase project.
 */
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
});

describe('health', () => {
  it('reports liveness without reaching Supabase', async () => {
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
    ['POST', '/api/auth/sign-out'],
    ['POST', '/api/auth/password'],
  ])('%s %s exists and rejects anonymous callers with 401', async (method, url) => {
    const response = await app.inject({ method: method as 'GET', url });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });

  it('rejects a malformed Authorization header rather than trusting it', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(response.statusCode).toBe(401);
  });

  it.each([
    ['/api/auth/sign-up'],
    ['/api/auth/sign-in'],
    ['/api/auth/refresh'],
    ['/api/auth/password/reset'],
  ])('%s is public and validates its body', async (url) => {
    const response = await app.inject({ method: 'POST', url, payload: {} });
    // Reaches validation rather than the guard: proves the route is unguarded.
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
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
    const document = app.swagger() as {
      paths: Record<string, unknown>;
      components?: { securitySchemes?: Record<string, unknown> };
    };
    const paths = Object.keys(document.paths);

    expect(paths).toContain('/api/users/me');
    expect(paths).toContain('/api/accounts');
    expect(paths).toContain('/api/accounts/{id}');
    expect(paths).toContain('/api/rules');
    expect(paths).toContain('/api/rules/evaluate');
    expect(paths).toContain('/api/auth/sign-in');
    expect(paths).toContain('/api/auth/me');

    expect(document.components?.securitySchemes).toHaveProperty('bearerAuth');
  });
});
