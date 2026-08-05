import { NotFoundError } from '../../lib/errors.js';
import { paginate, type Paginated } from '../../lib/pagination.js';
import { evaluateRules } from './rules.engine.js';
import type { RulesRepository } from './rules.repository.js';
import type { RuleRow } from './rules.schema.js';
import type {
  CreateRuleInput,
  EvaluateRulesResult,
  ListRulesQuery,
  Rule,
  TransactionCandidate,
  UpdateRuleInput,
} from './rules.types.js';

function toRule(row: RuleRow): Rule {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    description: row.description,
    priority: row.priority,
    isEnabled: row.isEnabled,
    conditions: row.conditions,
    actions: row.actions,
    stopProcessing: row.stopProcessing,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
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
      userId,
      name: input.name,
      description: input.description ?? null,
      priority: input.priority,
      isEnabled: input.isEnabled,
      conditions: input.conditions,
      actions: input.actions,
      stopProcessing: input.stopProcessing,
    });
    return toRule(row);
  }

  async update(userId: string, id: string, input: UpdateRuleInput): Promise<Rule> {
    const row = await this.repository.update(userId, id, {
      ...input,
      description: input.description === undefined ? undefined : (input.description ?? null),
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
