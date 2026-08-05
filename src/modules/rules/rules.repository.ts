import { and, asc, count, eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { PaginationQuery } from '../../lib/pagination.js';
import { rules, type NewRuleRow, type RuleRow } from './rules.schema.js';

export interface ListRulesFilter extends PaginationQuery {
  userId: string;
  enabledOnly: boolean;
}

export class RulesRepository {
  constructor(private readonly db: Database) {}

  async list(filter: ListRulesFilter): Promise<{ rows: RuleRow[]; total: number }> {
    const where = and(
      eq(rules.userId, filter.userId),
      filter.enabledOnly ? eq(rules.isEnabled, true) : undefined,
    );

    const [rows, [totals]] = await Promise.all([
      this.db
        .select()
        .from(rules)
        .where(where)
        .orderBy(asc(rules.priority), asc(rules.createdAt))
        .limit(filter.limit)
        .offset(filter.offset),
      this.db.select({ value: count() }).from(rules).where(where),
    ]);

    return { rows, total: totals?.value ?? 0 };
  }

  /** Unpaginated, enabled-only — used by the evaluation path. */
  async listEnabled(userId: string): Promise<RuleRow[]> {
    return this.db
      .select()
      .from(rules)
      .where(and(eq(rules.userId, userId), eq(rules.isEnabled, true)))
      .orderBy(asc(rules.priority), asc(rules.createdAt));
  }

  async findById(userId: string, id: string): Promise<RuleRow | undefined> {
    const [row] = await this.db
      .select()
      .from(rules)
      .where(and(eq(rules.id, id), eq(rules.userId, userId)))
      .limit(1);
    return row;
  }

  async create(values: NewRuleRow): Promise<RuleRow> {
    const [row] = await this.db.insert(rules).values(values).returning();
    return row!;
  }

  async update(userId: string, id: string, values: Partial<NewRuleRow>): Promise<RuleRow | undefined> {
    const [row] = await this.db
      .update(rules)
      .set({ ...values, updatedAt: new Date() })
      .where(and(eq(rules.id, id), eq(rules.userId, userId)))
      .returning();
    return row;
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const removed = await this.db
      .delete(rules)
      .where(and(eq(rules.id, id), eq(rules.userId, userId)))
      .returning({ id: rules.id });
    return removed.length > 0;
  }
}
