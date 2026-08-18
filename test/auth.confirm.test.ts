import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import { isExemptPath } from '../src/plugins/client-version.js';

/**
 * The address-confirmation bridge (D17 in `add-ios-onboarding`).
 *
 * Most of what could go wrong here is invisible in a browser until production:
 * a CSP that blocks the one script the page exists to run, a client-build gate
 * that answers a mail client with "update your app", or a redirect that quietly
 * loses the fragment. Each has an assertion.
 */
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
});

async function fetchBridge() {
  return app.inject({ method: 'GET', url: '/auth/confirm' });
}

describe('the confirmation bridge', () => {
  it('serves HTML outside /api, with no app build header', async () => {
    const response = await fetchBridge();

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/html/);
  });

  it('is a page rather than a redirect, because a fragment never reaches the server', async () => {
    const response = await fetchBridge();

    // A 3xx here would be the defect this whole route exists to avoid: the
    // session arrives in `#access_token=…`, which the server is never sent, so
    // a redirect handler has nothing to forward.
    expect(response.statusCode).not.toBeGreaterThanOrEqual(300);
    expect(response.body).toContain('location.hash');
  });

  it('hands over to the app scheme, carrying both halves of the URL', async () => {
    const { body } = await fetchBridge();

    expect(body).toContain('budj://auth/confirm');
    expect(body).toContain('window.location.search + window.location.hash');
  });

  it('offers a button for the embedded browsers that block the automatic hop', async () => {
    const { body } = await fetchBridge();

    expect(body).toContain('id="open"');
    expect(body).toContain('Open Budj');
  });

  it('takes the session out of the address bar before handing it over', async () => {
    const { body } = await fetchBridge();

    expect(body).toContain('history.replaceState');
  });

  it('serves a policy that permits its own inline script', async () => {
    const response = await fetchBridge();
    const policy = response.headers['content-security-policy'];

    // The page is useless without its script, and helmet's default
    // `script-src 'self'` would refuse it — in production only, which is the
    // worst place to find out. The hash is computed from the served script, so
    // this fails if the two ever drift.
    expect(policy).toBeTypeOf('string');
    const script = String(response.body).match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
    expect(script).not.toBe('');
    const hash = createHash('sha256').update(script, 'utf8').digest('base64');
    expect(policy).toContain(`'sha256-${hash}'`);
  });

  it('is never cached, and leaks nothing through a referrer', async () => {
    const response = await fetchBridge();

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  it('is exempt from the client build gate', () => {
    // A mail client has no `X-Client-Build` to send. Without the exemption the
    // gate answers 426 and the person is told to update an app they are in the
    // middle of signing into.
    expect(isExemptPath('/auth/confirm')).toBe(true);
  });

  it('is where sign-up sends people, and password reset is not', () => {
    expect(config.auth.confirmUrl).toMatch(/\/auth\/confirm$/);
    // A recovery link also returns a session. Sending it through the
    // confirmation hand-off would sign someone in and tell them their email was
    // confirmed when they asked for a new password.
    expect(config.auth.redirectUrl).not.toBe(config.auth.confirmUrl);
  });
});
