import type { PaginationQuery } from '../../lib/pagination.js';
import { toAppError, type Supabase, type Tables } from '../../supabase/index.js';
import type { AccountType } from './accounts.types.js';

export type AccountRow = Tables<'accounts'>;

export interface ListAccountsFilter extends PaginationQuery {
  userId: string;
  type?: AccountType | undefined;
  connectionId?: string | undefined;
  includeDisconnected: boolean;
}

/**
 * Read-only data access. Accounts are written by the connection sync in
 * `bank-connections`, never through this module — there is deliberately no
 * `create`, `update` or `remove` here.
 *
 * The client is built per request and carries the user's JWT, so RLS already
 * restricts every statement to rows they own. The explicit `.eq('user_id', …)`
 * filters are the second, redundant guard: if a policy were ever dropped, these
 * still hold.
 */
export class AccountsRepository {
  constructor(private readonly supabase: Supabase) {}

  async list(filter: ListAccountsFilter): Promise<{ rows: AccountRow[]; total: number }> {
    let query = this.supabase
      .from('accounts')
      .select('*', { count: 'exact' })
      .eq('user_id', filter.userId);

    if (filter.type) query = query.eq('type', filter.type);
    if (filter.connectionId) query = query.eq('connection_id', filter.connectionId);
    if (!filter.includeDisconnected) query = query.is('disconnected_at', null);

    const { data, error, count } = await query
      .order('name', { ascending: true })
      .range(filter.offset, filter.offset + filter.limit - 1);

    if (error) throw toAppError(error, { resource: 'Account' });
    return { rows: data ?? [], total: count ?? 0 };
  }

  async findById(userId: string, id: string): Promise<AccountRow | undefined> {
    const { data, error } = await this.supabase
      .from('accounts')
      .select('*')
      .eq('user_id', userId)
      .eq('id', id)
      .maybeSingle();

    if (error) throw toAppError(error, { resource: 'Account' });
    return data ?? undefined;
  }
}
