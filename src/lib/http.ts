import { z } from 'zod';

/** Shape returned by the global error handler for every failed request. */
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/** Reusable response map so route schemas stay short. */
export const errorResponses = {
  400: errorResponseSchema,
  401: errorResponseSchema,
  403: errorResponseSchema,
  404: errorResponseSchema,
  409: errorResponseSchema,
  422: errorResponseSchema,
} as const;

export const idParamSchema = z.object({
  id: z.uuid(),
});

export type IdParam = z.infer<typeof idParamSchema>;
