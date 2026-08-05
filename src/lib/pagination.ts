import { z } from 'zod';

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/** Query params every list endpoint accepts. */
export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  offset: z.coerce.number().int().min(0).default(0),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** Envelope every list endpoint returns. */
export function paginatedSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    data: z.array(item),
    meta: z.object({
      total: z.number().int(),
      limit: z.number().int(),
      offset: z.number().int(),
      hasMore: z.boolean(),
    }),
  });
}

export interface Paginated<T> {
  data: T[];
  meta: { total: number; limit: number; offset: number; hasMore: boolean };
}

export function paginate<T>(data: T[], total: number, { limit, offset }: PaginationQuery): Paginated<T> {
  return {
    data,
    meta: { total, limit, offset, hasMore: offset + data.length < total },
  };
}
