import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { BillingRepository } from '../../src/modules/billing/billing.repository.js';
import {
  cleanupTestUsers,
  describeIntegration,
  serviceClient,
  signUpTestUser,
  type TestUser,
} from './harness.js';

/**
 * The entitlement gate, end to end: a real user, a real Supabase token, real
 * RLS, and the actual HTTP response an unsubscribed caller gets.
 *
 * The unit tests prove the predicate. This proves it is wired to the routes
 * that need it, and — just as importantly — absent from the ones that must
 * stay reachable without paying.
 */
describeIntegration('requireSubscription', () => {
  let app: FastifyInstance;
  let unsubscribed: TestUser;
  let subscribed: TestUser;

  const auth = (user: TestUser) => ({ authorization: `Bearer ${user.accessToken}` });

  beforeAll(async () => {
    app = await buildApp();
    unsubscribed = await signUpTestUser();
    subscribed = await signUpTestUser();

    await new BillingRepository(serviceClient()).upsert({
      userId: subscribed.id,
      originalTransactionId: `otx-${subscribed.id}`,
      productId: 'com.budj.standard.yearly',
      planCode: 'standard',
      status: 'active',
      expiresAt: '2099-01-01T00:00:00.000Z',
      notificationUuid: null,
      notificationAt: null,
    });
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestUsers();
  });

  it('refuses a gated route with 402 and a distinguishable code', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/rules',
      headers: auth(unsubscribed),
    });

    expect(response.statusCode).toBe(402);
    expect(response.json()).toMatchObject({ error: { code: 'SUBSCRIPTION_REQUIRED' } });
  });

  /**
   * The converse of the ungated list below. Bank connections and devices are
   * past the paywall; asserting both directions is what stops the gate quietly
   * drifting onto, or off, the wrong routes.
   */
  it.each([
    ['GET', '/api/bank-connections'],
    ['POST', '/api/bank-connections/authorise'],
    ['GET', '/api/devices'],
  ])('refuses %s %s without a subscription', async (method, url) => {
    const response = await app.inject({
      method: method as 'GET',
      url,
      headers: auth(unsubscribed),
    });

    expect(response.statusCode).toBe(402);
  });

  it('admits a subscribed caller to the same route', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/rules',
      headers: auth(subscribed),
    });

    expect(response.statusCode).toBe(200);
  });

  /**
   * 401 and 402 must stay distinguishable: the app sends one person to a
   * sign-in screen and the other to a purchase screen.
   */
  it('still answers 401, not 402, for an anonymous caller', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/rules' });

    expect(response.statusCode).toBe(401);
  });

  /**
   * The deadlock this would cause is the reason it is called out in the spec: a
   * user who has not paid is exactly who needs to be told that billing is the
   * step they are on.
   */
  it.each([
    ['/api/billing/plans'],
    ['/api/billing/subscription'],
    ['/api/auth/me'],
    ['/api/users/me'],
    // The one that would deadlock the app at screen two if it were gated.
    ['/api/onboarding/status'],
  ])('leaves %s reachable without a subscription', async (url) => {
    const response = await app.inject({ method: 'GET', url, headers: auth(unsubscribed) });

    expect(response.statusCode).toBe(200);
  });

  it('reports an unsubscribed user as inactive rather than refusing to say', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/billing/subscription',
      headers: auth(unsubscribed),
    });

    expect(response.json()).toMatchObject({ active: false, planCode: null, status: null });
  });

  it('reports a subscribed user as active with their plan', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/billing/subscription',
      headers: auth(subscribed),
    });

    expect(response.json()).toMatchObject({ active: true, planCode: 'standard' });
  });

  it('serves the catalogue from code, limits included', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/billing/plans',
      headers: auth(unsubscribed),
    });

    const { data } = response.json() as { data: Array<{ code: string; maxConnections: number }> };
    expect(data.map((plan) => plan.code)).toEqual(['standard']);
    expect(data.find((plan) => plan.code === 'standard')?.maxConnections).toBe(10);
  });

  /** Purchase submission cannot require a subscription to reach. */
  it('lets an unsubscribed caller reach purchase submission', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/transaction',
      headers: auth(unsubscribed),
      payload: { signedTransaction: 'not-a-real-jws' },
    });

    // 400 from verification, not 402 from the gate — it got past the guard.
    expect(response.statusCode).toBe(400);
  });

  /**
   * A subscription whose expiry has passed while its status still says active
   * — a missed or delayed EXPIRED notification. Entitlement must not be
   * inferred from that silence.
   */
  it('refuses a caller whose cached subscription has silently lapsed', async () => {
    const lapsed = await signUpTestUser();

    await new BillingRepository(serviceClient()).upsert({
      userId: lapsed.id,
      originalTransactionId: `otx-${lapsed.id}`,
      productId: 'com.budj.standard.yearly',
      planCode: 'standard',
      status: 'active',
      expiresAt: '2020-01-01T00:00:00.000Z',
      notificationUuid: null,
      notificationAt: null,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/rules',
      headers: auth(lapsed),
    });

    expect(response.statusCode).toBe(402);
  });
});
