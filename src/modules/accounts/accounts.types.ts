import { z } from 'zod';
import { paginatedSchema, paginationQuerySchema } from '../../lib/pagination.js';

/**
 * Accounts are a **read-only projection of what Akahu reports**, not a
 * user-owned table. There are no create, update or delete DTOs here on purpose:
 * a user cannot invent an account, rename one, or delete one. The connection
 * sync in `bank-connections` is the only writer.
 */

export const accountTypes = [
  'checking',
  'savings',
  'credit_card',
  'cash',
  'loan',
  'investment',
  /** Fallback for an Akahu type this codebase has no mapping for. */
  'other',
] as const;

export const accountTypeSchema = z.enum(accountTypes);
export type AccountType = z.infer<typeof accountTypeSchema>;

export const accountSchema = z.object({
  id: z.uuid(),
  userId: z.string(),
  /** The `akahu_connections` row this account arrived through. */
  connectionId: z.uuid(),
  /** Akahu's own identifier (`acc_...`). Stable across syncs. */
  akahuAccountId: z.string(),
  name: z.string(),
  type: accountTypeSchema,
  currency: z.string().length(3),
  /**
   * Two capability flags, not one — Akahu governs paying out and receiving
   * separately. A credit card can trigger a rule and can never receive money,
   * and the rule editor needs to know that.
   */
  paymentFrom: z.boolean(),
  paymentTo: z.boolean(),
  /** Last time Akahu reported this account. */
  lastSeenAt: z.iso.datetime(),
  /** Set when Akahu stops reporting the account, or the connection is revoked. */
  disconnectedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Account = z.infer<typeof accountSchema>;

export const listAccountsQuerySchema = paginationQuerySchema.extend({
  type: accountTypeSchema.optional(),
  connectionId: z.uuid().optional(),
  includeDisconnected: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export type ListAccountsQuery = z.infer<typeof listAccountsQuerySchema>;

export const accountListSchema = paginatedSchema(accountSchema);
