import { sql } from 'drizzle-orm';
import { boolean, char, index, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { user } from '../auth/auth.schema.js';

export const accountTypeEnum = pgEnum('account_type', [
  'checking',
  'savings',
  'credit_card',
  'cash',
  'loan',
  'investment',
]);

/** A budget account belonging to a user. Distinct from better-auth's `auth_account`. */
export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: accountTypeEnum('type').notNull(),
    /** ISO-4217. Stored uppercase. */
    currency: char('currency', { length: 3 }).notNull().default('GBP'),
    /** Money as `numeric` — driver returns a string, never a float. */
    balance: numeric('balance', { precision: 14, scale: 2 }).notNull().default('0'),
    institution: text('institution'),
    isArchived: boolean('is_archived').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('accounts_user_id_idx').on(table.userId),
    uniqueIndex('accounts_user_id_name_key').on(table.userId, sql`lower(${table.name})`),
  ],
);

export type AccountRow = typeof accounts.$inferSelect;
export type NewAccountRow = typeof accounts.$inferInsert;
