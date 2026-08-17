import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { AkahuTokenRepository } from '../../src/modules/bank-connections/token.repository.js';
import { BillingRepository } from '../../src/modules/billing/billing.repository.js';
import {
  cleanupTestUsers,
  describeIntegration,
  serviceClient,
  signUpTestUser,
  type TestUser,
} from './harness.js';

/**
 * Device registration and the derived onboarding status, end to end.
 *
 * The step machine is unit-tested. What needs a database is the upsert
 * behaviour, the RLS boundary between users, and — the point of D1 — that a
 * status request reflects a change made elsewhere with nothing advancing it.
 */
describeIntegration('devices and onboarding', () => {
  let app: FastifyInstance;

  const auth = (user: TestUser) => ({ authorization: `Bearer ${user.accessToken}` });

  async function subscribedUser(): Promise<TestUser> {
    const user = await signUpTestUser();
    await new BillingRepository(serviceClient()).upsert({
      userId: user.id,
      originalTransactionId: `otx-${user.id}`,
      productId: 'com.budj.pro.monthly',
      planCode: 'pro',
      status: 'active',
      expiresAt: '2099-01-01T00:00:00.000Z',
      notificationUuid: null,
      notificationAt: null,
    });
    return user;
  }

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestUsers();
  });

  it('registers a device and returns it without the APNs token', async () => {
    const user = await subscribedUser();

    const response = await app.inject({
      method: 'POST',
      url: '/api/devices',
      headers: auth(user),
      payload: { deviceId: 'device-1', apnsToken: 'apns-token-1' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ deviceId: 'device-1', revokedAt: null });
    // A delivery credential must not be echoed back to anyone who can list.
    expect(response.body).not.toContain('apns-token-1');
  });

  it('keeps two devices for the same user', async () => {
    const user = await subscribedUser();

    for (const deviceId of ['phone', 'tablet']) {
      await app.inject({
        method: 'POST',
        url: '/api/devices',
        headers: auth(user),
        payload: { deviceId, apnsToken: `token-${deviceId}` },
      });
    }

    const response = await app.inject({ method: 'GET', url: '/api/devices', headers: auth(user) });
    const { data } = response.json() as { data: Array<{ deviceId: string }> };

    expect(data.map((device) => device.deviceId).sort()).toEqual(['phone', 'tablet']);
  });

  /** APNs reissues tokens, so this is routine rather than exceptional. */
  it('replaces the token when the same device re-registers', async () => {
    const user = await subscribedUser();

    await app.inject({
      method: 'POST',
      url: '/api/devices',
      headers: auth(user),
      payload: { deviceId: 'phone', apnsToken: 'token-old' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/devices',
      headers: auth(user),
      payload: { deviceId: 'phone', apnsToken: 'token-new' },
    });

    const { data } = await serviceClient()
      .from('device_registrations')
      .select('apns_token')
      .eq('user_id', user.id);

    expect(data).toHaveLength(1);
    expect(data?.[0]?.apns_token).toBe('token-new');
  });

  it('marks a revoked device rather than deleting it', async () => {
    const user = await subscribedUser();
    await app.inject({
      method: 'POST',
      url: '/api/devices',
      headers: auth(user),
      payload: { deviceId: 'phone', apnsToken: 'token' },
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/devices/phone',
      headers: auth(user),
    });

    expect(response.statusCode).toBe(204);

    const { data } = await serviceClient()
      .from('device_registrations')
      .select('revoked_at')
      .eq('user_id', user.id);

    expect(data).toHaveLength(1);
    expect(data?.[0]?.revoked_at).not.toBeNull();

    // ...and it stops being listed.
    const list = await app.inject({ method: 'GET', url: '/api/devices', headers: auth(user) });
    expect((list.json() as { data: unknown[] }).data).toEqual([]);
  });

  it("returns 404 when revoking someone else's device", async () => {
    const owner = await subscribedUser();
    const stranger = await subscribedUser();

    await app.inject({
      method: 'POST',
      url: '/api/devices',
      headers: auth(owner),
      payload: { deviceId: 'owners-phone', apnsToken: 'token' },
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/devices/owners-phone',
      headers: auth(stranger),
    });

    expect(response.statusCode).toBe(404);

    // The owner's registration is untouched.
    const { data } = await serviceClient()
      .from('device_registrations')
      .select('revoked_at')
      .eq('user_id', owner.id);
    expect(data?.[0]?.revoked_at).toBeNull();
  });

  it('rejects a registration carrying anything resembling key material', async () => {
    const user = await subscribedUser();

    const response = await app.inject({
      method: 'POST',
      url: '/api/devices',
      headers: auth(user),
      payload: { deviceId: 'phone', apnsToken: 'token', publicKey: 'MFkwEwYHKoZ...' },
    });

    // Zod strips it; the point is that nothing is stored and no column exists.
    expect(response.statusCode).toBe(200);
    const { data } = await serviceClient()
      .from('device_registrations')
      .select('*')
      .eq('user_id', user.id)
      .single();
    expect(JSON.stringify(data)).not.toContain('MFkwEwYHKoZ');
  });

  describe_status();

  function describe_status(): void {
    it('reports billing for a newly signed-in user, without a 402', async () => {
      const user = await signUpTestUser();

      const response = await app.inject({
        method: 'GET',
        url: '/api/onboarding/status',
        headers: auth(user),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ step: 'billing', subscriptionActive: false });
    });

    it('rejects an anonymous caller', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/onboarding/status' });

      expect(response.statusCode).toBe(401);
    });

    /**
     * The reason the step is derived rather than stored. Entitlement is granted
     * by a completely separate path, and the very next status request reflects
     * it — nothing advances the user.
     */
    it('moves from billing to bank with no write to advance it', async () => {
      const user = await signUpTestUser();

      const before = await app.inject({
        method: 'GET',
        url: '/api/onboarding/status',
        headers: auth(user),
      });
      expect((before.json() as { step: string }).step).toBe('billing');

      await new BillingRepository(serviceClient()).upsert({
        userId: user.id,
        originalTransactionId: `otx-${user.id}`,
        productId: 'com.budj.pro.monthly',
        planCode: 'pro',
        status: 'active',
        expiresAt: '2099-01-01T00:00:00.000Z',
        notificationUuid: null,
        notificationAt: null,
      });

      const after = await app.inject({
        method: 'GET',
        url: '/api/onboarding/status',
        headers: auth(user),
      });
      expect((after.json() as { step: string }).step).toBe('bank');
    });

    it('moves from bank to ready once a token is stored', async () => {
      const user = await subscribedUser();
      await new AkahuTokenRepository(serviceClient()).store(user.id, 'user_token_x', 'akahu_1');

      const response = await app.inject({
        method: 'GET',
        url: '/api/onboarding/status',
        headers: auth(user),
      });

      expect(response.json()).toMatchObject({ step: 'ready', bankConnected: true });
    });

    /** Declining notifications must never hold someone at a step. */
    it('reports ready with push outstanding', async () => {
      const user = await subscribedUser();
      await new AkahuTokenRepository(serviceClient()).store(user.id, 'user_token_y', 'akahu_2');

      const response = await app.inject({
        method: 'GET',
        url: '/api/onboarding/status',
        headers: auth(user),
      });

      expect(response.json()).toMatchObject({ step: 'ready', pushRegistered: false });
    });

    it('reports push registered once a device is added', async () => {
      const user = await subscribedUser();
      await new AkahuTokenRepository(serviceClient()).store(user.id, 'user_token_z', 'akahu_3');
      await app.inject({
        method: 'POST',
        url: '/api/devices',
        headers: auth(user),
        payload: { deviceId: 'phone', apnsToken: 'token' },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/onboarding/status',
        headers: auth(user),
      });

      expect(response.json()).toMatchObject({ step: 'ready', pushRegistered: true });
    });

    /**
     * Resumability: abandoning after billing and coming back lands on `bank`,
     * with nothing repeated.
     */
    it('resumes at the same step after the app is closed and reopened', async () => {
      const user = await subscribedUser();

      const first = await app.inject({
        method: 'GET',
        url: '/api/onboarding/status',
        headers: auth(user),
      });
      const second = await app.inject({
        method: 'GET',
        url: '/api/onboarding/status',
        headers: auth(user),
      });

      expect(first.json()).toEqual(second.json());
      expect((second.json() as { step: string }).step).toBe('bank');
    });
  }
});
