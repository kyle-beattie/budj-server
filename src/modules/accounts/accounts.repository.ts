import type { PaginationQuery } from '../../lib/pagination.js';
import { toAppError, type InsertDto, type Supabase, type Tables, type UpdateDto } from '../../supabase/index.js';
import type { AccountType } from './accounts.types.js';

export type AccountRow = Tables<'accounts'>;
export type NewAccountRow = InsertDto<'accounts'>;
export type AccountPatch = UpdateDto<'accounts'>;

export interface ListAccountsFilter extends PaginationQuery {
  userId: string;
  type?: AccountType | undefined;
  includeArchived: boolean;
}

/**
 * Data access only — no business rules, no HTTP concepts.
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
    if (!filter.includeArchived) query = query.eq('is_archived', false);

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

  async create(values: NewAccountRow, conflictMessage: string): Promise<AccountRow> {
    const { data, error } = await this.supabase.from('accounts').insert(values).select().single();

    if (error) throw toAppError(error, { resource: 'Account', conflictMessage });
    return data;
  }

  async update(
    userId: string,
    id: string,
    values: AccountPatch,
    conflictMessage: string,
  ): Promise<AccountRow | undefined> {
    const { data, error } = await this.supabase
      .from('accounts')
      .update(values)
      .eq('user_id', userId)
      .eq('id', id)
      .select()
      .maybeSingle();

    if (error) throw toAppError(error, { resource: 'Account', conflictMessage });
    return data ?? undefined;
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('accounts')
      .delete()
      .eq('user_id', userId)
      .eq('id', id)
      .select('id');

    if (error) throw toAppError(error, { resource: 'Account' });
    return (data?.length ?? 0) > 0;
  }
}
