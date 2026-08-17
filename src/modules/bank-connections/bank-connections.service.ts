import type { FastifyBaseLogger } from 'fastify';
import { BadRequestError, NotFoundError, PlanLimitExceededError } from '../../lib/errors.js';
import type { Plan } from '../billing/plans.js';
import { AccountSync } from './account-sync.js';
import type { AkahuClient } from './akahu.client.js';
import type { AkahuConnectionsRepository, ConnectionRow } from './connections.repository.js';
import type { AkahuStateRepository } from './state.repository.js';
import type { AkahuTokenRepository } from './token.repository.js';
import type { BankConnection } from './bank-connections.types.js';

function toBankConnection(row: ConnectionRow): BankConnection {
  return {
    id: row.id,
    akahuConnectionId: row.connection_id,
    name: row.name,
    logoUrl: row.logo_url,
    connectedAt: new Date(row.connected_at).toISOString(),
    disconnectedAt: row.disconnected_at ? new Date(row.disconnected_at).toISOString() : null,
  };
}

/**
 * The Akahu connection lifecycle.
 *
 * The server is always in the middle: it starts the authorisation, it performs
 * the code exchange, it holds the token, and it is the only thing that ever
 * calls Akahu. The app opens a URL and posts back a code.
 */
export class BankConnectionsService {
  constructor(
    private readonly connections: AkahuConnectionsRepository,
    private readonly states: AkahuStateRepository,
    private readonly tokens: AkahuTokenRepository,
    private readonly akahu: AkahuClient,
    private readonly logger: FastifyBaseLogger,
  ) {}

  async list(userId: string, includeDisconnected: boolean): Promise<BankConnection[]> {
    const rows = await this.connections.listConnections(userId, includeDisconnected);
    return rows.map(toBankConnection);
  }

  /**
   * Start authorisation.
   *
   * The plan limit is checked **before** anything is issued: sending someone
   * through their bank's authorisation screen only to refuse them on the way
   * back would be a genuinely hostile thing to build.
   */
  async startAuthorisation(userId: string, plan: Plan): Promise<{ authorisationUrl: string }> {
    const active = await this.connections.countActiveConnections(userId);

    if (active >= plan.maxConnections) {
      throw new PlanLimitExceededError(
        `The ${plan.name} plan allows ${plan.maxConnections} connected banks`,
        { limit: plan.maxConnections, current: active, planCode: plan.code },
      );
    }

    const state = await this.states.issue(userId);
    return this.akahu.createAuthorisationRequest(state);
  }

  /**
   * Complete authorisation: consume the state, exchange the code, store the
   * token, sync the projection.
   *
   * The state is consumed **first**. Anything else — exchanging the code, then
   * discovering the state was replayed — would already have burned a one-shot
   * code and, worse, obtained a token before establishing who it belongs to.
   *
   * `state.userId` is also checked against the authenticated caller. Both
   * bindings are required: the JWT proves who is asking, the state proves they
   * are the one who started this flow.
   */
  async completeAuthorisation(
    userId: string,
    input: { code: string; state: string },
  ): Promise<{ connections: number; accounts: number }> {
    const consumed = await this.states.consume(input.state);

    if (!consumed) {
      // Unknown, expired, or already used — indistinguishable on purpose.
      throw new BadRequestError('Authorisation state is invalid, expired, or already used');
    }

    if (consumed.userId !== userId) {
      this.logger.warn(
        { userId, stateOwner: consumed.userId },
        'Authorisation state was issued to a different user; refusing the exchange',
      );
      throw new BadRequestError('Authorisation state is invalid, expired, or already used');
    }

    const { accessToken } = await this.akahu.exchangeCode(input.code);

    // The plaintext exists only as this argument; `store` encrypts before
    // building the query, so no code path writes it.
    const akahuUserId = await this.akahu.getAkahuUserId(accessToken).catch(() => null);
    await this.tokens.store(userId, accessToken, akahuUserId);

    const accounts = await this.akahu.listAccounts(accessToken);
    const result = await new AccountSync(this.connections, this.logger).sync(userId, accounts);

    return { connections: result.connections, accounts: result.accounts };
  }

  /**
   * Revoke a single connection.
   *
   * Marks the connection and its accounts disconnected. It deliberately does
   * **not** revoke the Akahu token: that token covers every connection the user
   * has, so revoking it here would silently disconnect their other banks too.
   * Losing entitlement is what revokes the token (D9); removing one bank is not.
   */
  async revokeConnection(userId: string, connectionId: string): Promise<void> {
    const connection = await this.connections.findConnection(userId, connectionId);
    if (!connection) throw new NotFoundError('Bank connection', connectionId);

    await this.connections.disconnectConnection(userId, connectionId, new Date().toISOString());
  }

  /** Re-run the projection against what Akahu currently reports. */
  async resync(userId: string): Promise<{ connections: number; accounts: number }> {
    const token = await this.tokens.getAkahuToken(userId);
    if (!token) throw new NotFoundError('Akahu connection');

    const accounts = await this.akahu.listAccounts(token);
    const result = await new AccountSync(this.connections, this.logger).sync(userId, accounts);

    return { connections: result.connections, accounts: result.accounts };
  }
}
