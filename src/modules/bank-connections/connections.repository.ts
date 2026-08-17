import { toAppError, type Supabase, type Tables } from '../../supabase/index.js';
import type { ProjectedAccount } from './account-mapping.js';

export type ConnectionRow = Tables<'akahu_connections'>;
export type AccountRow = Tables<'accounts'>;

/**
 * The account projection and the connections it hangs off.
 *
 * Every write here is an upsert or a mark, never a delete. Akahu is the source
 * of truth for what exists; this table is the local record of what we have been
 * told, and a rule that references a since-removed account still has to be able
 * to explain itself.
 */
export class AkahuConnectionsRepository {
  constructor(private readonly supabase: Supabase) {}

  async listConnections(userId: string, includeDisconnected = false): Promise<ConnectionRow[]> {
    let query = this.supabase
      .from('akahu_connections')
      .select('*')
      .eq('user_id', userId)
      .order('connected_at', { ascending: true });

    if (!includeDisconnected) query = query.is('disconnected_at', null);

    const { data, error } = await query;
    if (error) throw toAppError(error, { resource: 'Bank connection' });
    return data ?? [];
  }

  async findConnection(userId: string, id: string): Promise<ConnectionRow | undefined> {
    const { data, error } = await this.supabase
      .from('akahu_connections')
      .select('*')
      .eq('user_id', userId)
      .eq('id', id)
      .maybeSingle();

    if (error) throw toAppError(error, { resource: 'Bank connection' });
    return data ?? undefined;
  }

  /** Active connections only — what the plan limit is measured against. */
  async countActiveConnections(userId: string): Promise<number> {
    const { count, error } = await this.supabase
      .from('akahu_connections')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .is('disconnected_at', null);

    if (error) throw toAppError(error, { resource: 'Bank connection' });
    return count ?? 0;
  }

  /**
   * Upsert a connection and return its local id.
   *
   * Reconnecting an institution the user previously revoked clears
   * `disconnected_at` rather than creating a second row, so the accounts that
   * already point at it stay pointed at it.
   */
  async upsertConnection(
    userId: string,
    connection: { akahuConnectionId: string; name: string; logo: string | null },
  ): Promise<string> {
    const { data, error } = await this.supabase
      .from('akahu_connections')
      .upsert(
        {
          user_id: userId,
          connection_id: connection.akahuConnectionId,
          name: connection.name,
          logo_url: connection.logo,
          disconnected_at: null,
        },
        { onConflict: 'user_id,connection_id' },
      )
      .select('id')
      .single();

    if (error) throw toAppError(error, { resource: 'Bank connection' });
    return data.id;
  }

  /** Upsert one account of the projection. Identity is Akahu's account id. */
  async upsertAccount(
    userId: string,
    connectionId: string,
    account: ProjectedAccount,
    seenAt: string,
  ): Promise<void> {
    const { error } = await this.supabase.from('accounts').upsert(
      {
        user_id: userId,
        connection_id: connectionId,
        akahu_account_id: account.akahuAccountId,
        name: account.name,
        type: account.type,
        payment_from: account.paymentFrom,
        payment_to: account.paymentTo,
        last_seen_at: seenAt,
        // A reappearing account is reconnected, not duplicated.
        disconnected_at: null,
      },
      { onConflict: 'user_id,akahu_account_id' },
    );

    if (error) throw toAppError(error, { resource: 'Account' });
  }

  /**
   * Mark every account of this user that Akahu did not report as disconnected.
   *
   * Identified by *absence from this sync* rather than by an explicit list, so
   * an account Akahu silently stops reporting is caught. Rows are never
   * deleted: `add-rule-triggers` will have rules pointing at them.
   */
  async markAccountsMissing(
    userId: string,
    seenAkahuAccountIds: readonly string[],
    disconnectedAt: string,
  ): Promise<void> {
    let query = this.supabase
      .from('accounts')
      .update({ disconnected_at: disconnectedAt })
      .eq('user_id', userId)
      .is('disconnected_at', null);

    if (seenAkahuAccountIds.length > 0) {
      query = query.not(
        'akahu_account_id',
        'in',
        `(${seenAkahuAccountIds.map((id) => `"${id}"`).join(',')})`,
      );
    }

    const { error } = await query;
    if (error) throw toAppError(error, { resource: 'Account' });
  }

  /** Revoking one connection: mark it and everything hanging off it. */
  async disconnectConnection(
    userId: string,
    connectionId: string,
    disconnectedAt: string,
  ): Promise<void> {
    const { error: connectionError } = await this.supabase
      .from('akahu_connections')
      .update({ disconnected_at: disconnectedAt })
      .eq('user_id', userId)
      .eq('id', connectionId);

    if (connectionError) throw toAppError(connectionError, { resource: 'Bank connection' });

    const { error: accountError } = await this.supabase
      .from('accounts')
      .update({ disconnected_at: disconnectedAt })
      .eq('user_id', userId)
      .eq('connection_id', connectionId)
      .is('disconnected_at', null);

    if (accountError) throw toAppError(accountError, { resource: 'Account' });
  }
}
