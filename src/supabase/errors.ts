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
