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
    ['GET', '/api/billing/plans'],
    ['GET', '/api/billing/subscription'],
    ['POST', '/api/billing/transaction'],
    ['GET', '/api/bank-connections'],
    ['POST', '/api/bank-connections/authorise'],
    ['POST', '/api/bank-connections/callback'],
    ['GET', '/api/devices'],
    ['POST', '/api/devices'],
    ['GET', '/api/onboarding/status'],
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

  /**
   * Apple holds no Supabase session, so this endpoint cannot require a JWT. It
   * must reach body validation for an anonymous caller — a 401 here would mean
   * `requireAuth` had been added, and every one of Apple's deliveries would
   * fail silently until entitlement drifted far enough for someone to notice.
   */
  it('leaves the App Store notification endpoint unauthenticated', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/apple/notifications',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('rejects an unverifiable notification without a 500', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/apple/notifications',
      payload: { signedPayload: 'not-a-jws' },
    });

    // 400, not 500 and not 200: retrying will not make it verify.
    expect(response.statusCode).toBe(400);
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

/**
 * A completeness check, rather than another list to keep up to date.
 *
 * The assertions above name specific routes, so a route added later is simply
 * absent from them and nobody notices. This walks every path the OpenAPI
 * document actually contains and requires each one to be either deliberately
 * public or rejecting anonymous callers — so a new route forces the decision to
 * be made explicitly, here, in this file.
 */
describe('every route makes an explicit decision about anonymous callers', () => {
  /** Public by design. Each entry needs a reason that survives review. */
  const PUBLIC_ROUTES = new Map<string, string>([
    ['POST /api/auth/sign-up', 'creating an account cannot require one'],
    ['POST /api/auth/sign-in', 'likewise'],
    ['POST /api/auth/refresh', 'the access token has expired by definition'],
    ['POST /api/auth/password/reset', 'the caller cannot sign in — that is the problem'],
    [
      'POST /api/billing/apple/notifications',
      'Apple holds no Supabase session; verified by JWS certificate chain instead',
    ],
  ]);

  it('guards or explicitly exempts each one', async () => {
    const document = app.swagger() as {
      paths: Record<string, Record<string, unknown>>;
    };

    const unaccounted: string[] = [];
    let checked = 0;

    for (const [path, operations] of Object.entries(document.paths)) {
      for (const method of Object.keys(operations)) {
        const route = `${method.toUpperCase()} ${path}`;
        if (PUBLIC_ROUTES.has(route)) continue;

        const response = await app.inject({
          method: method.toUpperCase() as 'GET',
          // Path parameters need *something* substituted to reach the handler.
          url: path.replace(/\{[^}]+\}/g, '00000000-0000-0000-0000-000000000000'),
          payload: method === 'get' || method === 'delete' ? undefined : {},
        });

        checked += 1;
        if (response.statusCode !== 401) unaccounted.push(`${route} → ${response.statusCode}`);
      }
    }

    expect(unaccounted).toEqual([]);
    // Guard against passing vacuously: an empty document would satisfy the
    // assertion above while proving nothing.
    expect(checked).toBeGreaterThan(20);
  });

  it('lists no public route that has since been guarded', async () => {
    const stale: string[] = [];

    for (const route of PUBLIC_ROUTES.keys()) {
      const [method, path] = route.split(' ') as [string, string];
      const response = await app.inject({ method: method as 'GET', url: path, payload: {} });

      // A public route reaches validation or succeeds; it never 401s.
      if (response.statusCode === 401) stale.push(route);
    }

    expect(stale).toEqual([]);
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
    expect(paths).toContain('/api/billing/apple/notifications');
    expect(paths).toContain('/api/billing/plans');
    expect(paths).toContain('/api/billing/subscription');
    expect(paths).toContain('/api/billing/transaction');
    expect(paths).toContain('/api/bank-connections');
    expect(paths).toContain('/api/bank-connections/authorise');
    expect(paths).toContain('/api/bank-connections/callback');
    expect(paths).toContain('/api/devices');
    expect(paths).toContain('/api/onboarding/status');
  });

  /**
   * D10: Face ID unlocks the app and the server knows nothing about it, and the
   * Secure Enclave key enrolment an earlier design had was dropped from the
   * product rather than deferred. Nothing in the contract should invite a
   * client to send key material.
   */
  it('accepts no cryptographic key material anywhere', async () => {
    const document = JSON.stringify(app.swagger());

    expect(document).not.toMatch(/publicKey|public_key|attestation|secureEnclave/i);
  });

  /**
   * Akahu redirects a browser back with `code` and `state`. The obvious shape
   * is a GET handler identifying the user from the state alone, which makes
   * that state the only thing between a leaked redirect URL and a stranger's
   * bank being attached to your account. The native app intercepts the redirect
   * and posts the code with its own token instead, so the exchange is bound
   * twice. A GET callback appearing here means someone rebuilt the weaker form.
   */
  it('exposes no unauthenticated bank callback', async () => {
    const document = app.swagger() as { paths: Record<string, Record<string, unknown>> };

    expect(Object.keys(document.paths['/api/bank-connections/callback'] ?? {})).toEqual(['post']);

    const response = await app.inject({
      method: 'GET',
      url: '/api/bank-connections/callback?code=x&state=y',
    });
    expect(response.statusCode).toBe(404);
  });

  /**
   * The server cannot cancel, pause or refund an Apple subscription — there is
   * no such API, only the user can, in App Store settings. A route claiming
   * otherwise would be a lie the contract propagates into the iOS client.
   */
  it('exposes no route claiming to cancel or pause a subscription', async () => {
    const document = app.swagger() as { paths: Record<string, unknown> };

    const cancellation = Object.keys(document.paths).filter((path) =>
      /cancel|pause|unsubscribe|refund/i.test(path),
    );
    expect(cancellation).toEqual([]);
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

    // Provider routes under the auth module — the ones a client calls to
    // establish identity. `/api/billing/apple/notifications` is Apple calling
    // us about a purchase, not a client authenticating, so it is not in scope.
    const providerAuthPaths = Object.keys(document.paths).filter((path) =>
      /^\/api\/auth\/.*(apple|google|oauth|provider)/i.test(path),
    );
    expect(providerAuthPaths).toEqual(['/api/auth/apple/grant']);

    const body = JSON.stringify(document.paths['/api/auth/apple/grant']);
    expect(body).toContain('authorizationCode');

    // No route anywhere accepts an identity token. Asserted across the whole
    // document, not just the auth module, so it cannot be reintroduced
    // somewhere this filter does not look.
    expect(JSON.stringify(document)).not.toMatch(/idToken|identityToken|id_token/i);
  });
});
