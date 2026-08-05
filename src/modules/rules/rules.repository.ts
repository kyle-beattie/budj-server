import type { PaginationQuery } from '../../lib/pagination.js';
import { toAppError, type InsertDto, type Supabase, type Tables, type UpdateDto } from '../../supabase/index.js';

export type RuleRow = Tables<'rules'>;
export type NewRuleRow = InsertDto<'rules'>;
export type RulePatch = UpdateDto<'rules'>;

export interface ListRulesFilter extends PaginationQuery {
  userId: string;
  enabledOnly: boolean;
}

/** See AccountsRepository for why both RLS and the explicit user filter apply. */
export class RulesRepository {
  constructor(private readonly supabase: Supabase) {}

  async list(filter: ListRulesFilter): Promise<{ rows: RuleRow[]; total: number }> {
    let query = this.supabase
      .from('rules')
      .select('*', { count: 'exact' })
      .eq('user_id', filter.userId);

    if (filter.enabledOnly) query = query.eq('is_enabled', true);

    const { data, error, count } = await query
      .order('priority', { ascending: true })
      .order('created_at', { ascending: true })
      .range(filter.offset, filter.offset + filter.limit - 1);

    if (error) throw toAppError(error, { resource: 'Rule' });
    return { rows: data ?? [], total: count ?? 0 };
  }

  /** Unpaginated, enabled-only — used by the evaluation path. */
  async listEnabled(userId: string): Promise<RuleRow[]> {
    const { data, error } = await this.supabase
      .from('rules')
      .select('*')
      .eq('user_id', userId)
      .eq('is_enabled', true)
      .order('priority', { ascending: true })
      .order('created_at', { ascending: true });

    if (error) throw toAppError(error, { resource: 'Rule' });
    return data ?? [];
  }

  async findById(userId: string, id: string): Promise<RuleRow | undefined> {
    const { data, error } = await this.supabase
      .from('rules')
      .select('*')
      .eq('user_id', userId)
      .eq('id', id)
      .maybeSingle();

    if (error) throw toAppError(error, { resource: 'Rule' });
    return data ?? undefined;
  }

  async create(values: NewRuleRow): Promise<RuleRow> {
    const { data, error } = await this.supabase.from('rules').insert(values).select().single();

    if (error) throw toAppError(error, { resource: 'Rule' });
    return data;
  }

  async update(userId: string, id: string, values: RulePatch): Promise<RuleRow | undefined> {
    const { data, error } = await this.supabase
      .from('rules')
      .update(values)
      .eq('user_id', userId)
      .eq('id', id)
      .select()
      .maybeSingle();

    if (error) throw toAppError(error, { resource: 'Rule' });
    return data ?? undefined;
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('rules')
      .delete()
      .eq('user_id', userId)
      .eq('id', id)
      .select('id');

    if (error) throw toAppError(error, { resource: 'Rule' });
    return (data?.length ?? 0) > 0;
  }
}
