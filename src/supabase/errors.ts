import type { AuthError, PostgrestError } from '@supabase/supabase-js';
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../lib/errors.js';

/** Postgres error codes PostgREST passes through verbatim. */
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';
/** PostgREST's code when RLS rejects a write, or a filter matched no rows. */
const RLS_VIOLATION = '42501';
const NO_ROWS_RETURNED = 'PGRST116';
/**
 * PostgREST's JWT codes. These are decided *before* any policy runs, so they
 * are never about the row being asked for.
 */
const JWT_INVALID = 'PGRST301';
const JWT_ANON_DISABLED = 'PGRST302';
const JWT_CLAIMS_INVALID = 'PGRST303';

/**
 * Turns a PostgrestError into the application's error vocabulary.
 *
 * `resource` is used for the 404 message. `conflictMessage` overrides the text
 * for a unique-violation, which is usually the only case worth explaining.
 */
export function toAppError(
  error: PostgrestError,
  options: { resource?: string; conflictMessage?: string } = {},
): AppError {
  const resource = options.resource ?? 'Resource';

  switch (error.code) {
    case NO_ROWS_RETURNED:
      return new NotFoundError(resource);
    case UNIQUE_VIOLATION:
      return new ConflictError(options.conflictMessage ?? `${resource} already exists`);
    case FOREIGN_KEY_VIOLATION:
      return new BadRequestError('A referenced record does not exist');
    case CHECK_VIOLATION:
      return new BadRequestError('A value violates a database constraint');
    case RLS_VIOLATION:
      // RLS rejected the write. From the caller's perspective the row may as
      // well not exist — don't confirm that someone else's row is there.
      return new NotFoundError(resource);
    case JWT_INVALID:
    case JWT_ANON_DISABLED:
      // PostgREST refused the token itself. `requireAuth` verified it against
      // the JWKS, so reaching here means it expired in the gap or the project's
      // signing key moved — either way, signing in again fixes it.
      return new UnauthorizedError('Session is no longer valid');
    case JWT_CLAIMS_INVALID:
      /**
       * A claim failed validation while the signature was fine — in practice
       * `iat`/`nbf` in the future, i.e. clock skew between whatever minted the
       * token and PostgREST. Observed on a freshly confirmed signup, where the
       * token is seconds old.
       *
       * **Deliberately not a 401.** The credential is good and the caller did
       * nothing wrong; re-authenticating hands them a *newer* token and makes
       * it worse, so sending them to the sign-in screen is a dead end. This is
       * transient and the right answer is to wait and retry, which is what 503
       * means — the same code an unreachable auth server gets in
       * `toAuthAppError`, for the same reason.
       */
      return new AppError('Authentication service unavailable', {
        statusCode: 503,
        code: 'AUTH_UNAVAILABLE',
        details: { code: error.code },
        cause: error,
      });
    default:
      return new AppError(error.message, {
        statusCode: 500,
        code: 'DATABASE_ERROR',
        details: { code: error.code, hint: error.hint },
        cause: error,
      });
  }
}

/** Maps a Supabase Auth (GoTrue) error onto an HTTP status. */
export function toAuthAppError(error: AuthError): AppError {
  const status = error.status ?? 500;

  // auth-js reports a network failure as `AuthRetryableFetchError` with
  // `status: 0` — the request never reached GoTrue, so there is no HTTP status
  // to map. Passing 0 through reaches `reply.status(0)`, which Fastify rejects
  // with FST_ERR_BAD_STATUS_CODE *inside* the error handler, so the caller gets
  // an empty 500 instead of our error envelope. Anything outside the HTTP error
  // range is treated as the auth server being unreachable.
  if (status < 400 || status > 599) {
    return new AppError('Authentication service unavailable', {
      statusCode: 503,
      code: 'AUTH_UNAVAILABLE',
      cause: error,
    });
  }

  switch (status) {
    case 400:
      // GoTrue uses 400 for both bad input and bad credentials.
      return error.code === 'invalid_credentials' || /invalid login/i.test(error.message)
        ? new UnauthorizedError('Invalid email or password')
        : new BadRequestError(error.message);
    case 401:
      return new UnauthorizedError(error.message);
    case 403:
      return new ForbiddenError(error.message);
    case 404:
      return new NotFoundError('User');
    case 409:
      return new ConflictError(error.message);
    case 422:
      return new BadRequestError(error.message);
    case 429:
      return new AppError('Too many attempts, try again shortly', {
        statusCode: 429,
        code: 'RATE_LIMITED',
      });
    default:
      return new AppError(error.message, {
        statusCode: status >= 500 ? 500 : status,
        code: error.code ?? 'AUTH_ERROR',
        cause: error,
      });
  }
}
