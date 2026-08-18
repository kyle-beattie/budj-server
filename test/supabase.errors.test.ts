import type { AuthError } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { toAuthAppError } from '../src/supabase/errors.js';

/**
 * auth-js does not export `AuthRetryableFetchError`, so stand in for it with
 * the shape it actually produces: a network failure carries `status: 0`.
 */
function authError(overrides: Partial<AuthError>): AuthError {
  return Object.assign(new Error(overrides.message ?? 'boom'), {
    name: 'AuthError',
    __isAuthError: true,
    ...overrides,
  }) as AuthError;
}

describe('toAuthAppError', () => {
  it('maps a network failure (status 0) to a 503 rather than a bad status code', () => {
    const mapped = toAuthAppError(
      authError({ name: 'AuthRetryableFetchError', message: 'fetch failed', status: 0 }),
    );

    expect(mapped.statusCode).toBe(503);
    expect(mapped.code).toBe('AUTH_UNAVAILABLE');
    // The transport failure is not the caller's business.
    expect(mapped.message).not.toContain('fetch');
  });

  it('defaults a missing status to 500', () => {
    expect(toAuthAppError(authError({ message: 'no status', status: undefined })).statusCode).toBe(
      500,
    );
  });

  it('still maps real HTTP statuses', () => {
    expect(toAuthAppError(authError({ message: 'nope', status: 401 })).statusCode).toBe(401);
    expect(
      toAuthAppError(authError({ message: 'bad login', status: 400, code: 'invalid_credentials' })),
    ).toMatchObject({ statusCode: 401, message: 'Invalid email or password' });
    expect(toAuthAppError(authError({ message: 'exists', status: 409 })).statusCode).toBe(409);
  });
});
