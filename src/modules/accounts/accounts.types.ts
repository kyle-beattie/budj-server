import { z } from 'zod';
import { paginatedSchema, paginationQuerySchema } from '../../lib/pagination.js';

export const accountTypes = [
  'checking',
  'savings',
  'credit_card',
  'cash',
  'loan',
  'investment',
] as const;

export const accountTypeSchema = z.enum(accountTypes);
export type AccountType = z.infer<typeof accountTypeSchema>;

/** Money crosses the wire as a fixed-point string, matching Postgres `numeric`. */
const moneySchema = z
  .string()
  .regex(/^-?\d{1,12}(\.\d{1,2})?$/, 'Expected a decimal amount with up to 2 places');

export const accountSchema = z.object({
  id: z.uuid(),
  userId: z.string(),
  name: z.string(),
  type: accountTypeSchema,
  currency: z.string().length(3),
  balance: z.string(),
  institution: z.string().nullable(),
  isArchived: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Account = z.infer<typeof accountSchema>;

export const createAccountSchema = z.object({
  name: z.string().trim().min(1).max(120),
  type: accountTypeSchema,
  currency: z
    .string()
    .length(3)
    .transform((value) => value.toUpperCase())
    .default('GBP'),
  balance: moneySchema.default('0'),
  institution: z.string().trim().max(120).nullish(),
});

export type CreateAccountInput = z.infer<typeof createAccountSchema>;

export const updateAccountSchema = createAccountSchema
  .partial()
  .extend({ isArchived: z.boolean().optional() })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });

export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;

export const listAccountsQuerySchema = paginationQuerySchema.extend({
  type: accountTypeSchema.optional(),
  includeArchived: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export type ListAccountsQuery = z.infer<typeof listAccountsQuerySchema>;

export const accountListSchema = paginatedSchema(accountSchema);
