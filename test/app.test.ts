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
    ['GET', '/api/rules'],
    ['POST', '/api/rules'],
    ['POST', '/api/rules/evaluate'],
    ['GET', '/api/auth/me'],
    ['POST', '/api/auth/sign-out'],
    ['POST', '/api/auth/password'],
    ['POST', '/api/auth/apple/grant'],
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

  /**
   * Accounts are a read-only projection of what Akahu reports. These verbs used
   * to exist and were asserted as guarded; they must now not exist at all. A
   * 404 rather than a 401 is the point — there is no route to authenticate to.
   */
  it.each([
    ['POST', '/api/accounts'],
    ['PATCH', '/api/accounts/00000000-0000-0000-0000-000000000000'],
    ['DELETE', '/api/accounts/00000000-0000-0000-0000-000000000000'],
  ])('%s %s no longer exists', async (method, url) => {
    const response = await app.inject({ method: method as 'POST', url, payload: {} });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
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

  /**
   * Balances are not stored, so they must not be describable either. This
   * asserts the *contract* rather than a response body: the iOS client is
   * generated from this document, and a `balance` property here would produce a
   * field the server can never populate.
   */
  it('describes accounts without a balance', async () => {
    const document = JSON.stringify(app.swagger());

    expect(document).toContain('akahuAccountId');
    expect(document).toContain('paymentFrom');
    expect(document).toContain('paymentTo');
    expect(document).not.toContain('balance');
  });

  /**
   * OAuth is client-to-Supabase: the app gets an identity token from Apple or
   * Google and calls `signInWithIdToken` **directly**, and this server only ever
   * verifies the resulting Supabase JWT (D2).
   *
   * The single permitted provider endpoint is the authorization *code* route,
   * which exists because Apple requires revocation at deletion and Supabase
   * exposes no refresh token (D13). A route taking an `idToken` would mean
   * someone had rebuilt the proxy flow D2 rejects, so the contract is asserted
   * rather than described.
   */
  it('exposes no route accepting a provider identity token', async () => {
    const document = app.swagger() as { paths: Record<string, unknown> };

    const providerPaths = Object.keys(document.paths).filter((path) =>
      /apple|google|oauth|provider/i.test(path),
    );
    expect(providerPaths).toEqual(['/api/auth/apple/grant']);

    const body = JSON.stringify(document.paths['/api/auth/apple/grant']);
    expect(body).toContain('authorizationCode');
    expect(body).not.toMatch(/idToken|identityToken|id_token/i);
  });
});
