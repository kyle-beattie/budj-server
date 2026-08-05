import { z } from 'zod';
import { paginatedSchema, paginationQuerySchema } from '../../lib/pagination.js';

/** Transaction fields a rule is allowed to look at. */
export const ruleFieldSchema = z.enum([
  'description',
  'merchant',
  'amount',
  'accountId',
  'currency',
  'reference',
]);
export type RuleField = z.infer<typeof ruleFieldSchema>;

export const ruleOperatorSchema = z.enum([
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'matches', // regular expression
  'gt',
  'gte',
  'lt',
  'lte',
]);
export type RuleOperator = z.infer<typeof ruleOperatorSchema>;

export const ruleConditionSchema = z.object({
  field: ruleFieldSchema,
  operator: ruleOperatorSchema,
  value: z.union([z.string(), z.number()]),
  caseSensitive: z.boolean().default(false),
});
export type RuleCondition = z.infer<typeof ruleConditionSchema>;

export const ruleActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set_category'), category: z.string().min(1).max(80) }),
  z.object({ type: z.literal('add_tags'), tags: z.array(z.string().min(1).max(40)).min(1) }),
  z.object({ type: z.literal('set_account'), accountId: z.uuid() }),
  z.object({ type: z.literal('set_note'), note: z.string().max(500) }),
  z.object({ type: z.literal('ignore') }),
]);
export type RuleAction = z.infer<typeof ruleActionSchema>;

export const ruleSchema = z.object({
  id: z.uuid(),
  userId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  priority: z.number().int(),
  isEnabled: z.boolean(),
  conditions: z.array(ruleConditionSchema),
  actions: z.array(ruleActionSchema),
  stopProcessing: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Rule = z.infer<typeof ruleSchema>;

export const createRuleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullish(),
  priority: z.number().int().min(0).max(10_000).default(100),
  isEnabled: z.boolean().default(true),
  conditions: z.array(ruleConditionSchema).min(1, 'A rule needs at least one condition'),
  actions: z.array(ruleActionSchema).min(1, 'A rule needs at least one action'),
  stopProcessing: z.boolean().default(false),
});
export type CreateRuleInput = z.infer<typeof createRuleSchema>;

export const updateRuleSchema = createRuleSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });
export type UpdateRuleInput = z.infer<typeof updateRuleSchema>;

export const listRulesQuerySchema = paginationQuerySchema.extend({
  enabledOnly: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});
export type ListRulesQuery = z.infer<typeof listRulesQuerySchema>;

export const ruleListSchema = paginatedSchema(ruleSchema);

/** The transaction shape rules are evaluated against. */
export const transactionCandidateSchema = z.object({
  description: z.string().default(''),
  merchant: z.string().nullish(),
  amount: z.number(),
  accountId: z.uuid().nullish(),
  currency: z.string().length(3).default('GBP'),
  reference: z.string().nullish(),
});
export type TransactionCandidate = z.infer<typeof transactionCandidateSchema>;

export const evaluateRulesBodySchema = z.object({
  transaction: transactionCandidateSchema,
});

export const evaluateRulesResponseSchema = z.object({
  matched: z.array(
    z.object({
      ruleId: z.uuid(),
      name: z.string(),
      actions: z.array(ruleActionSchema),
    }),
  ),
  /** Actions folded together in priority order — what you'd apply. */
  outcome: z.object({
    category: z.string().nullable(),
    tags: z.array(z.string()),
    accountId: z.uuid().nullable(),
    note: z.string().nullable(),
    ignored: z.boolean(),
  }),
});
export type EvaluateRulesResult = z.infer<typeof evaluateRulesResponseSchema>;
