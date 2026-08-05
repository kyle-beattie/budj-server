import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { paginate, type Paginated } from '../../lib/pagination.js';
import type { AccountRow } from './accounts.schema.js';
import type { AccountsRepository } from './accounts.repository.js';
import type {
  Account,
  CreateAccountInput,
  ListAccountsQuery,
  UpdateAccountInput,
} from './accounts.types.js';

/** Postgres unique-violation. */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === UNIQUE_VIOLATION;
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    type: row.type,
    currency: row.currency,
    balance: row.balance,
    institution: row.institution,
    isArchived: row.isArchived,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Business rules for budget accounts. Takes a `userId` on every call rather than
 * a request, so it stays testable and can't accidentally act on the wrong user.
 */
export class AccountsService {
  constructor(private readonly repository: AccountsRepository) {}

  async list(userId: string, query: ListAccountsQuery): Promise<Paginated<Account>> {
    const { rows, total } = await this.repository.list({ ...query, userId });
    return paginate(rows.map(toAccount), total, query);
  }

  async getById(userId: string, id: string): Promise<Account> {
    const row = await this.repository.findById(userId, id);
    if (!row) throw new NotFoundError('Account', id);
    return toAccount(row);
  }

  async create(userId: string, input: CreateAccountInput): Promise<Account> {
    try {
      const row = await this.repository.create({
        userId,
        name: input.name,
        type: input.type,
        currency: input.currency,
        balance: input.balance,
        institution: input.institution ?? null,
      });
      return toAccount(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(`You already have an account named '${input.name}'`);
      }
      throw error;
    }
  }

  async update(userId: string, id: string, input: UpdateAccountInput): Promise<Account> {
    try {
      const row = await this.repository.update(userId, id, {
        ...input,
        institution: input.institution === undefined ? undefined : (input.institution ?? null),
      });
      if (!row) throw new NotFoundError('Account', id);
      return toAccount(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(`You already have an account named '${input.name}'`);
      }
      throw error;
    }
  }

  async remove(userId: string, id: string): Promise<void> {
    const removed = await this.repository.remove(userId, id);
    if (!removed) throw new NotFoundError('Account', id);
  }
}
