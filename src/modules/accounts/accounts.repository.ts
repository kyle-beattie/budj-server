import { and, asc, count, eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { PaginationQuery } from '../../lib/pagination.js';
import { accounts, type AccountRow, type NewAccountRow } from './accounts.schema.js';
import type { AccountType } from './accounts.types.js';

export interface ListAccountsFilter extends PaginationQuery {
  userId: string;
  type?: AccountType | undefined;
  includeArchived: boolean;
}

/**
 * Data access only — no business rules, no HTTP concepts. Every query is scoped
 * by `userId` so a missing filter can't leak another user's rows.
 */
export class AccountsRepository {
  constructor(private readonly db: Database) {}

  async list(filter: ListAccountsFilter): Promise<{ rows: AccountRow[]; total: number }> {
    const where = and(
      eq(accounts.userId, filter.userId),
      filter.type ? eq(accounts.type, filter.type) : undefined,
      filter.includeArchived ? undefined : eq(accounts.isArchived, false),
    );

    const [rows, [totals]] = await Promise.all([
      this.db
        .select()
        .from(accounts)
        .where(where)
        .orderBy(asc(accounts.name))
        .limit(filter.limit)
        .offset(filter.offset),
      this.db.select({ value: count() }).from(accounts).where(where),
    ]);

    return { rows, total: totals?.value ?? 0 };
  }

  async findById(userId: string, id: string): Promise<AccountRow | undefined> {
    const [row] = await this.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, id), eq(accounts.userId, userId)))
      .limit(1);
    return row;
  }

  async create(values: NewAccountRow): Promise<AccountRow> {
    const [row] = await this.db.insert(accounts).values(values).returning();
    return row!;
  }

  async update(
    userId: string,
    id: string,
    values: Partial<NewAccountRow>,
  ): Promise<AccountRow | undefined> {
    const [row] = await this.db
      .update(accounts)
      .set({ ...values, updatedAt: new Date() })
      .where(and(eq(accounts.id, id), eq(accounts.userId, userId)))
      .returning();
    return row;
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const removed = await this.db
      .delete(accounts)
      .where(and(eq(accounts.id, id), eq(accounts.userId, userId)))
      .returning({ id: accounts.id });
    return removed.length > 0;
  }
}
