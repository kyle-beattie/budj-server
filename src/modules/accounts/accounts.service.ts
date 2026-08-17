import { NotFoundError } from '../../lib/errors.js';
import { paginate, type Paginated } from '../../lib/pagination.js';
import type { AccountRow, AccountsRepository } from './accounts.repository.js';
import type { Account, ListAccountsQuery } from './accounts.types.js';

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    userId: row.user_id,
    connectionId: row.connection_id,
    akahuAccountId: row.akahu_account_id,
    name: row.name,
    type: row.type,
    currency: row.currency,
    paymentFrom: row.payment_from,
    paymentTo: row.payment_to,
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    disconnectedAt: row.disconnected_at ? new Date(row.disconnected_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/**
 * Read-only access to the account projection. Takes a `userId` on every call
 * rather than a request, so it stays testable and can't accidentally act on the
 * wrong user.
 *
 * No balances are exposed because none are stored: a stale balance is worse
 * than no balance, and nothing in the product reads one.
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
}
