/**
 * Application-level errors. Services throw these; the global error handler in
 * `plugins/error-handler.ts` is the only place that turns them into responses.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(
    message: string,
    options: { statusCode?: number; code?: string; details?: unknown; cause?: unknown } = {},
  ) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.statusCode = options.statusCode ?? 500;
    this.code = options.code ?? 'INTERNAL_ERROR';
    this.details = options.details;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', details?: unknown) {
    super(message, { statusCode: 400, code: 'BAD_REQUEST', details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, { statusCode: 401, code: 'UNAUTHORIZED' });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have access to this resource') {
    super(message, { statusCode: 403, code: 'FORBIDDEN' });
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource', id?: string) {
    super(id ? `${resource} '${id}' was not found` : `${resource} was not found`, {
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource already exists', details?: unknown) {
    super(message, { statusCode: 409, code: 'CONFLICT', details });
  }
}

export class UnprocessableEntityError extends AppError {
  constructor(message = 'Request could not be processed', details?: unknown) {
    super(message, { statusCode: 422, code: 'UNPROCESSABLE_ENTITY', details });
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
