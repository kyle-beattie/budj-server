import type { AuthError, PostgrestError } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { toAppError, toAuthAppError } from '../src/supabase/errors.js';

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

function postgrestError(code: string, message = 'boom'): PostgrestError {
  return Object.assign(new Error(message), {
    name: 'PostgrestError',
    code,
    details: '',
    hint: '',
    message,
  }) as PostgrestError;
}

describe('toAppError', () => {
  /**
   * PostgREST rejects the token before it consults a policy, so these are never
   * about the row that was asked for. Left unmapped they fall through to the
   * `default` branch and surface as 500 DATABASE_ERROR, which tells the app a
   * credential problem is a server outage.
   */
  it('maps a clock-skewed JWT (PGRST303) to a retryable 503, not a 401 or a 500', () => {
    const mapped = toAppError(postgrestError('PGRST303', 'JWT issued at future'), {
      resource: 'Subscription',
    });

    expect(mapped.statusCode).toBe(503);
    expect(mapped.code).toBe('AUTH_UNAVAILABLE');
    // 401 would send them to the sign-in screen, where a newer token makes the
    // skew worse rather than better.
    expect(mapped.statusCode).not.toBe(401);
    expect(mapped.code).not.toBe('DATABASE_ERROR');
    // PostgREST's wording is an implementation detail, not a user-facing one.
    expect(mapped.message).not.toContain('JWT');
  });

  it('maps a rejected token (PGRST301/302) to 401', () => {
    for (const code of ['PGRST301', 'PGRST302']) {
      expect(toAppError(postgrestError(code))).toMatchObject({
        statusCode: 401,
        code: 'UNAUTHORIZED',
      });
    }
  });

  it('leaves every other PostgREST failure a 500', () => {
    expect(toAppError(postgrestError('PGRST100', 'bad query'))).toMatchObject({
      statusCode: 500,
      code: 'DATABASE_ERROR',
    });
  });

  it('still maps the row-level cases it always did', () => {
    expect(toAppError(postgrestError('PGRST116'), { resource: 'Rule' })).toMatchObject({
      statusCode: 404,
    });
    expect(toAppError(postgrestError('23505'), { resource: 'Rule' })).toMatchObject({
      statusCode: 409,
    });
    // An RLS rejection must stay a 404: a 403 confirms someone else's row is
    // there.
    expect(toAppError(postgrestError('42501'), { resource: 'Rule' })).toMatchObject({
      statusCode: 404,
    });
  });
});
