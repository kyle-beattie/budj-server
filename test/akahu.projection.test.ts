import { describe, expect, it, vi } from 'vitest';
import { AccountSync } from '../src/modules/bank-connections/account-sync.js';
import {
  mapAccountType,
  mapPaymentCapability,
  projectAccount,
} from '../src/modules/bank-connections/account-mapping.js';
import type { AkahuAccount } from '../src/modules/bank-connections/akahu.types.js';
import type { AkahuConnectionsRepository } from '../src/modules/bank-connections/connections.repository.js';

const silentLogger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as ConstructorParameters<
  typeof AccountSync
>[1];

function akahuAccount(overrides: Partial<AkahuAccount> = {}): AkahuAccount {
  return {
    _id: 'acc_1',
    name: 'Everyday',
    type: 'CHECKING',
    attributes: ['TRANSACTIONS'],
    connection: { _id: 'conn_1', name: 'ANZ' },
    ...overrides,
  } as AkahuAccount;
}

describe('mapAccountType', () => {
  it.each([
    ['CHECKING', 'checking'],
    ['SAVINGS', 'savings'],
    ['CREDITCARD', 'credit_card'],
    ['LOAN', 'loan'],
    ['INVESTMENT', 'investment'],
    ['WALLET', 'cash'],
    ['KIWISAVER', 'investment'],
    ['TERMDEPOSIT', 'savings'],
  ] as const)('maps %s to %s', (akahu, expected) => {
    expect(mapAccountType(akahu)).toBe(expected);
  });

  /**
   * These could each be forced into a local type, and deliberately are not: a
   * foreign-currency account is not a cheque account and a rewards balance is
   * not money. `other` says "we do not model this", which is true.
   */
  it.each([['FOREIGN'], ['TAX'], ['REWARDS']])('maps %s to other rather than guessing', (akahu) => {
    expect(mapAccountType(akahu)).toBe('other');
  });

  /** Akahu's vocabulary can grow without notice. */
  it('maps a type it has never seen to other', () => {
    expect(mapAccountType('CRYPTO_VAULT')).toBe('other');
    expect(mapAccountType('')).toBe('other');
  });

  it('is not case sensitive', () => {
    expect(mapAccountType('checking')).toBe('checking');
  });
});

describe('mapPaymentCapability', () => {
  it('reads both directions from the attributes', () => {
    expect(mapPaymentCapability(['TRANSACTIONS', 'PAYMENT_FROM', 'PAYMENT_TO'])).toEqual({
      paymentFrom: true,
      paymentTo: true,
    });
  });

  /**
   * The case the two flags exist for: a credit card can commonly pay out and
   * can never receive. One flag would have collapsed this.
   */
  it('records paying out without being able to receive', () => {
    expect(mapPaymentCapability(['PAYMENT_FROM'])).toEqual({ paymentFrom: true, paymentTo: false });
  });

  it('treats an account with no attributes as capable of neither', () => {
    expect(mapPaymentCapability([])).toEqual({ paymentFrom: false, paymentTo: false });
  });
});

describe('projectAccount', () => {
  it('keeps only what the projection stores', () => {
    const projected = projectAccount(
      akahuAccount({ attributes: ['PAYMENT_FROM'], connection: { _id: 'conn_1', name: 'ASB', logo: 'https://l' } }),
    );

    expect(projected).toEqual({
      akahuAccountId: 'acc_1',
      akahuConnectionId: 'conn_1',
      connectionName: 'ASB',
      connectionLogo: 'https://l',
      name: 'Everyday',
      type: 'checking',
      paymentFrom: true,
      paymentTo: false,
    });
  });
});

describe('AccountSync', () => {
  interface Recorder {
    repository: AkahuConnectionsRepository;
    connections: Array<{ akahuConnectionId: string }>;
    accounts: Array<{ akahuAccountId: string; connectionId: string }>;
    missingCalls: Array<readonly string[]>;
  }

  function recorder(): Recorder {
    const connections: Recorder['connections'] = [];
    const accounts: Recorder['accounts'] = [];
    const missingCalls: Recorder['missingCalls'] = [];

    return {
      connections,
      accounts,
      missingCalls,
      repository: {
        upsertConnection: async (_userId: string, connection: { akahuConnectionId: string }) => {
          connections.push(connection);
          return `local-${connection.akahuConnectionId}`;
        },
        upsertAccount: async (
          _userId: string,
          connectionId: string,
          account: { akahuAccountId: string },
        ) => {
          accounts.push({ akahuAccountId: account.akahuAccountId, connectionId });
        },
        markAccountsMissing: async (_userId: string, seen: readonly string[]) => {
          missingCalls.push(seen);
        },
      } as unknown as AkahuConnectionsRepository,
    };
  }

  it('upserts one connection per institution, not one per account', async () => {
    const rec = recorder();

    await new AccountSync(rec.repository, silentLogger).sync('user-1', [
      akahuAccount({ _id: 'acc_1' }),
      akahuAccount({ _id: 'acc_2' }),
      akahuAccount({ _id: 'acc_3', connection: { _id: 'conn_2', name: 'ASB' } }),
    ]);

    expect(rec.connections.map((c) => c.akahuConnectionId)).toEqual(['conn_1', 'conn_2']);
    expect(rec.accounts).toHaveLength(3);
  });

  it('attaches each account to its own connection', async () => {
    const rec = recorder();

    await new AccountSync(rec.repository, silentLogger).sync('user-1', [
      akahuAccount({ _id: 'acc_1' }),
      akahuAccount({ _id: 'acc_2', connection: { _id: 'conn_2', name: 'ASB' } }),
    ]);

    expect(rec.accounts).toEqual([
      { akahuAccountId: 'acc_1', connectionId: 'local-conn_1' },
      { akahuAccountId: 'acc_2', connectionId: 'local-conn_2' },
    ]);
  });

  /** Akahu legitimately reports two accounts sharing a name. */
  it('keeps two identically named accounts apart by their Akahu ids', async () => {
    const rec = recorder();

    await new AccountSync(rec.repository, silentLogger).sync('user-1', [
      akahuAccount({ _id: 'acc_1', name: 'Savings' }),
      akahuAccount({ _id: 'acc_2', name: 'Savings' }),
    ]);

    expect(rec.accounts.map((a) => a.akahuAccountId)).toEqual(['acc_1', 'acc_2']);
  });

  it('marks accounts Akahu no longer reports as missing', async () => {
    const rec = recorder();

    await new AccountSync(rec.repository, silentLogger).sync('user-1', [akahuAccount({ _id: 'acc_1' })]);

    expect(rec.missingCalls).toEqual([['acc_1']]);
  });

  /**
   * An unrecognised type must not abort the sync — the other accounts still
   * need importing.
   */
  it('completes when one account has an unmappable type', async () => {
    const rec = recorder();

    const result = await new AccountSync(rec.repository, silentLogger).sync('user-1', [
      akahuAccount({ _id: 'acc_1', type: 'CHECKING' }),
      akahuAccount({ _id: 'acc_2', type: 'SOMETHING_NEW' }),
      akahuAccount({ _id: 'acc_3', type: 'SAVINGS' }),
    ]);

    expect(result.accounts).toBe(3);
    expect(rec.accounts).toHaveLength(3);
  });

  /**
   * The guard worth arguing about. An empty response is ambiguous — "removed
   * everything" or "Akahu had a bad minute" — and treating the second as the
   * first would, once add-rule-triggers lands, silently stop every rule the
   * user has.
   */
  it('never disconnects everything on an empty response', async () => {
    const rec = recorder();

    const result = await new AccountSync(rec.repository, silentLogger).sync('user-1', []);

    expect(rec.missingCalls).toEqual([]);
    expect(result.disconnected).toBe(false);
  });
});
