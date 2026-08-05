import { NotFoundError } from '../../lib/errors.js';
import { paginate, type Paginated } from '../../lib/pagination.js';
import type { AccountRow, AccountsRepository } from './accounts.repository.js';
import type {
  Account,
  CreateAccountInput,
  ListAccountsQuery,
  UpdateAccountInput,
} from './accounts.types.js';

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    type: row.type,
    currency: row.currency,
    balance: row.balance,
    institution: row.institution,
    isArchived: row.is_archived,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
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
    const row = await this.repository.create(
      {
        user_id: userId,
        name: input.name,
        type: input.type,
        currency: input.currency,
        balance: input.balance,
        institution: input.institution ?? null,
      },
      `You already have an account named '${input.name}'`,
    );
    return toAccount(row);
  }

  async update(userId: string, id: string, input: UpdateAccountInput): Promise<Account> {
    const row = await this.repository.update(
      userId,
      id,
      {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.balance !== undefined ? { balance: input.balance } : {}),
        ...(input.institution !== undefined ? { institution: input.institution ?? null } : {}),
        ...(input.isArchived !== undefined ? { is_archived: input.isArchived } : {}),
      },
      // `name` is optional on a patch — don't interpolate `undefined` into the
      // message when the rename wasn't what collided.
      input.name
        ? `You already have an account named '${input.name}'`
        : 'An account with that name already exists',
    );
    if (!row) throw new NotFoundError('Account', id);
    return toAccount(row);
  }

  async remove(userId: string, id: string): Promise<void> {
    const removed = await this.repository.remove(userId, id);
    if (!removed) throw new NotFoundError('Account', id);
  }
}
