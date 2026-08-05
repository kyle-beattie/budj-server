import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { user } from '../auth/auth.schema.js';
import type { RuleAction, RuleCondition } from './rules.types.js';

/**
 * A user-defined rule that classifies incoming transactions.
 * Conditions and actions are JSONB so the shape can evolve without a migration;
 * `rules.types.ts` is the source of truth for what's valid.
 */
export const rules = pgTable(
  'rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    /** Lower runs first. Ties break on `createdAt`. */
    priority: integer('priority').notNull().default(100),
    isEnabled: boolean('is_enabled').notNull().default(true),
    /** All conditions must match (AND). */
    conditions: jsonb('conditions').$type<RuleCondition[]>().notNull().default([]),
    actions: jsonb('actions').$type<RuleAction[]>().notNull().default([]),
    /** Stop evaluating further rules once this one matches. */
    stopProcessing: boolean('stop_processing').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('rules_user_id_idx').on(table.userId),
    index('rules_user_id_priority_idx').on(table.userId, table.priority),
  ],
);

export type RuleRow = typeof rules.$inferSelect;
export type NewRuleRow = typeof rules.$inferInsert;
