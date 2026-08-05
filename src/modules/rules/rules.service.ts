import { NotFoundError } from '../../lib/errors.js';
import { paginate, type Paginated } from '../../lib/pagination.js';
import type { Json } from '../../supabase/index.js';
import { evaluateRules } from './rules.engine.js';
import type { RuleRow, RulesRepository } from './rules.repository.js';
import type {
  CreateRuleInput,
  EvaluateRulesResult,
  ListRulesQuery,
  Rule,
  RuleAction,
  RuleCondition,
  TransactionCandidate,
  UpdateRuleInput,
} from './rules.types.js';

/**
 * `conditions` and `actions` are jsonb, so PostgREST hands them back as `Json`.
 * They were validated by Zod on the way in and the column has no other writer,
 * so the assertion is safe; validating again on every read would cost more than
 * it catches.
 */
function toRule(row: RuleRow): Rule {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description,
    priority: row.priority,
    isEnabled: row.is_enabled,
    conditions: (row.conditions ?? []) as unknown as RuleCondition[],
    actions: (row.actions ?? []) as unknown as RuleAction[],
    stopProcessing: row.stop_processing,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export class RulesService {
  constructor(private readonly repository: RulesRepository) {}

  async list(userId: string, query: ListRulesQuery): Promise<Paginated<Rule>> {
    const { rows, total } = await this.repository.list({ ...query, userId });
    return paginate(rows.map(toRule), total, query);
  }

  async getById(userId: string, id: string): Promise<Rule> {
    const row = await this.repository.findById(userId, id);
    if (!row) throw new NotFoundError('Rule', id);
    return toRule(row);
  }

  async create(userId: string, input: CreateRuleInput): Promise<Rule> {
    const row = await this.repository.create({
      user_id: userId,
      name: input.name,
      description: input.description ?? null,
      priority: input.priority,
      is_enabled: input.isEnabled,
      conditions: input.conditions as unknown as Json,
      actions: input.actions as unknown as Json,
      stop_processing: input.stopProcessing,
    });
    return toRule(row);
  }

  async update(userId: string, id: string, input: UpdateRuleInput): Promise<Rule> {
    const row = await this.repository.update(userId, id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description ?? null } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.isEnabled !== undefined ? { is_enabled: input.isEnabled } : {}),
      ...(input.conditions !== undefined
        ? { conditions: input.conditions as unknown as Json }
        : {}),
      ...(input.actions !== undefined ? { actions: input.actions as unknown as Json } : {}),
      ...(input.stopProcessing !== undefined ? { stop_processing: input.stopProcessing } : {}),
    });
    if (!row) throw new NotFoundError('Rule', id);
    return toRule(row);
  }

  async remove(userId: string, id: string): Promise<void> {
    const removed = await this.repository.remove(userId, id);
    if (!removed) throw new NotFoundError('Rule', id);
  }

  /** Dry-run the user's enabled rules against a candidate transaction. */
  async evaluate(userId: string, transaction: TransactionCandidate): Promise<EvaluateRulesResult> {
    const rows = await this.repository.listEnabled(userId);
    return evaluateRules(transaction, rows.map(toRule));
  }
}
