import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import errorHandlerPlugin from '../src/plugins/error-handler.js';
import clientVersionPlugin, {
  evaluateClientBuild,
  isExemptPath,
  isMoneyMovementBlocked,
  type ClientGateOptions,
} from '../src/plugins/client-version.js';

const GATED: ClientGateOptions = {
  minimumBuild: 400,
  blockedMoneyBuilds: { from: 412, to: 418 },
};

describe('evaluateClientBuild', () => {
  it('admits a build at or above the minimum', () => {
    expect(evaluateClientBuild('400', GATED)).toEqual({ allowed: true, build: 400 });
    expect(evaluateClientBuild('999', GATED)).toEqual({ allowed: true, build: 999 });
  });

  it('refuses a build below the minimum', () => {
    expect(evaluateClientBuild('399', GATED)).toEqual({ allowed: false, reason: 'unsupported' });
  });

  /**
   * The rule that makes the whole gate worth having. A client that cannot be
   * identified cannot be gated, so treating absence as "probably fine" hands
   * every stale build — and anyone who simply omits the header — a bypass.
   */
  it.each([
    ['a missing header', undefined],
    ['an empty header', ''],
    ['a whitespace header', '   '],
  ])('refuses %s rather than exempting it', (_label, header) => {
    expect(evaluateClientBuild(header, GATED)).toEqual({ allowed: false, reason: 'missing' });
  });

  it.each([['abc'], ['1.2.3'], ['400.1'], ['-400'], ['400a'], ['1e3'], ['99999999999']])(
    'refuses the malformed build %s',
    (header) => {
      expect(evaluateClientBuild(header, GATED)).toEqual({ allowed: false, reason: 'malformed' });
    },
  );

  it('tolerates surrounding whitespace on a real value', () => {
    expect(evaluateClientBuild(' 401 ', GATED)).toEqual({ allowed: true, build: 401 });
  });

  describe('when no minimum is configured', () => {
    const OPEN: ClientGateOptions = { minimumBuild: null, blockedMoneyBuilds: null };

    it('admits everything, including a missing header', () => {
      expect(evaluateClientBuild(undefined, OPEN)).toEqual({ allowed: true, build: null });
      expect(evaluateClientBuild('1', OPEN)).toEqual({ allowed: true, build: 1 });
    });
  });
});

describe('isMoneyMovementBlocked', () => {
  it.each([[412], [415], [418]])('blocks build %d inside the range', (build) => {
    expect(isMoneyMovementBlocked(build, GATED)).toBe(true);
  });

  it.each([[411], [419], [500]])('allows build %d outside the range', (build) => {
    expect(isMoneyMovementBlocked(build, GATED)).toBe(false);
  });

  /**
   * The block is independent of the minimum supported build: a build can be
   * perfectly current and still be refused for payments, which is the entire
   * point of keeping the two settings separate.
   */
  it('blocks a build that is well above the minimum', () => {
    expect(evaluateClientBuild('415', GATED).allowed).toBe(true);
    expect(isMoneyMovementBlocked(415, GATED)).toBe(true);
  });

  it('does not trust an unidentifiable client with money', () => {
    expect(isMoneyMovementBlocked(null, GATED)).toBe(true);
  });

  it('blocks nothing when no range is configured', () => {
    expect(isMoneyMovementBlocked(415, { minimumBuild: 400, blockedMoneyBuilds: null })).toBe(false);
  });
});

describe('isExemptPath', () => {
  /**
   * Not client requests. Apple holds no app build, and gating its deliveries
   * would silently break subscription state until entitlement drifted far
   * enough for someone to notice.
   */
  it.each([
    ['/api/billing/apple/notifications'],
    ['/api/akahu/webhook'],
    ['/healthz'],
    ['/docs'],
    ['/docs/static/index.html'],
  ])('exempts %s', (path) => {
    expect(isExemptPath(path)).toBe(true);
  });

  it.each([['/api/rules'], ['/api/accounts'], ['/api/onboarding/status'], ['/api/billing/plans']])(
    'does not exempt %s',
    (path) => {
      expect(isExemptPath(path)).toBe(false);
    },
  );

  /** A lookalike prefix must not inherit the exemption. */
  it('does not exempt a path that merely starts with an exempt name', () => {
    expect(isExemptPath('/healthzz')).toBe(false);
    expect(isExemptPath('/api/billing/apple/notifications-evil')).toBe(false);
  });
});

describe('the gate over HTTP', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function appWith(options: ClientGateOptions): Promise<FastifyInstance> {
    const instance = Fastify();
    await instance.register(errorHandlerPlugin);
    await instance.register(clientVersionPlugin, options);

    instance.get('/api/rules', async () => ({ ok: true }));
    instance.get('/healthz', async () => ({ ok: true }));
    instance.post('/api/billing/apple/notifications', async () => ({ ok: true }));
    instance.post(
      '/api/payments',
      { onRequest: [instance.requireMoneyMovementAllowed] },
      async () => ({ ok: true }),
    );

    await instance.ready();
    app = instance;
    return instance;
  }

  it('refuses an outdated build with a distinguishable code', async () => {
    const instance = await appWith(GATED);

    const response = await instance.inject({
      method: 'GET',
      url: '/api/rules',
      headers: { 'x-client-build': '399' },
    });

    expect(response.statusCode).toBe(426);
    expect(response.json()).toMatchObject({ error: { code: 'CLIENT_UPDATE_REQUIRED' } });
  });

  it('refuses a request carrying no build identifier', async () => {
    const instance = await appWith(GATED);

    const response = await instance.inject({ method: 'GET', url: '/api/rules' });

    expect(response.statusCode).toBe(426);
    expect(response.json()).toMatchObject({ error: { code: 'CLIENT_UPDATE_REQUIRED' } });
  });

  it('admits a supported build', async () => {
    const instance = await appWith(GATED);

    const response = await instance.inject({
      method: 'GET',
      url: '/api/rules',
      headers: { 'x-client-build': '500' },
    });

    expect(response.statusCode).toBe(200);
  });

  it.each([
    ['GET', '/healthz'],
    ['POST', '/api/billing/apple/notifications'],
  ])('leaves %s %s unaffected without a build header', async (method, url) => {
    const instance = await appWith(GATED);

    const response = await instance.inject({ method: method as 'GET', url });

    expect(response.statusCode).toBe(200);
  });

  /**
   * The independence the spec asks for: a blocked build loses only the
   * dangerous operations. Killing an entire client version because its amount
   * handling is wrong is a worse outcome than refusing the operations that
   * depend on it.
   */
  it('refuses money movement from a blocked build while its other requests succeed', async () => {
    const instance = await appWith(GATED);
    const headers = { 'x-client-build': '415' };

    const ordinary = await instance.inject({ method: 'GET', url: '/api/rules', headers });
    const payment = await instance.inject({ method: 'POST', url: '/api/payments', headers });

    expect(ordinary.statusCode).toBe(200);
    expect(payment.statusCode).toBe(409);
    expect(payment.json()).toMatchObject({ error: { code: 'CLIENT_BUILD_BLOCKED' } });
  });

  it('allows money movement from a build outside the blocked range', async () => {
    const instance = await appWith(GATED);

    const response = await instance.inject({
      method: 'POST',
      url: '/api/payments',
      headers: { 'x-client-build': '500' },
    });

    expect(response.statusCode).toBe(200);
  });

  it('ignores the query string when matching exempt paths', async () => {
    const instance = await appWith(GATED);

    const response = await instance.inject({ method: 'GET', url: '/healthz?probe=1' });

    expect(response.statusCode).toBe(200);
  });

  it('is inert when no minimum is configured', async () => {
    const instance = await appWith({ minimumBuild: null, blockedMoneyBuilds: null });

    const response = await instance.inject({ method: 'GET', url: '/api/rules' });

    expect(response.statusCode).toBe(200);
  });
});
