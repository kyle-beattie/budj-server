import type { FastifyBaseLogger } from 'fastify';
import { projectAccount } from './account-mapping.js';
import type { AkahuAccount } from './akahu.types.js';
import type { AkahuConnectionsRepository } from './connections.repository.js';

export interface SyncResult {
  connections: number;
  accounts: number;
  disconnected: boolean;
}

/**
 * Bring the local projection into line with what Akahu currently reports.
 *
 * Run after a new connection, and safe to run again at any time — it is a
 * convergence, not an event handler. Nothing about it depends on knowing what
 * changed.
 *
 * Two rules do the work:
 *
 * - **Identity is Akahu's account id**, so a renamed account is the same
 *   account and two accounts sharing a name are still two accounts.
 * - **Absence means disconnected, not deleted.** An account Akahu stops
 *   reporting is marked, because a rule may point at it and a dangling
 *   reference explains nothing to the user.
 */
export class AccountSync {
  constructor(
    private readonly repository: AkahuConnectionsRepository,
    private readonly logger: FastifyBaseLogger,
  ) {}

  async sync(userId: string, akahuAccounts: readonly AkahuAccount[], now = new Date()): Promise<SyncResult> {
    const seenAt = now.toISOString();
    const projected = akahuAccounts.map(projectAccount);

    // One upsert per institution, not per account.
    const connectionIds = new Map<string, string>();
    for (const account of projected) {
      if (connectionIds.has(account.akahuConnectionId)) continue;

      connectionIds.set(
        account.akahuConnectionId,
        await this.repository.upsertConnection(userId, {
          akahuConnectionId: account.akahuConnectionId,
          name: account.connectionName,
          logo: account.connectionLogo,
        }),
      );
    }

    for (const account of projected) {
      const connectionId = connectionIds.get(account.akahuConnectionId)!;
      await this.repository.upsertAccount(userId, connectionId, account, seenAt);
    }

    /**
     * Guard against wiping the projection on a bad response.
     *
     * An empty account list is ambiguous: it means either "this user
     * disconnected everything" or "Akahu had a bad minute". Treating the second
     * as the first marks every account disconnected and, once
     * `add-rule-triggers` lands, silently stops every rule the user has.
     *
     * So an empty response never disconnects anything. The cost is that a user
     * who genuinely removes their last account keeps a stale row until their
     * next sync reports something; the cost the other way is every rule
     * stopping because of a transient upstream failure.
     */
    if (projected.length === 0) {
      this.logger.warn(
        { userId },
        'Akahu reported no accounts; leaving the existing projection untouched rather than ' +
          'treating an empty response as a full disconnection',
      );
      return { connections: 0, accounts: 0, disconnected: false };
    }

    await this.repository.markAccountsMissing(
      userId,
      projected.map((account) => account.akahuAccountId),
      seenAt,
    );

    return {
      connections: connectionIds.size,
      accounts: projected.length,
      disconnected: true,
    };
  }
}
