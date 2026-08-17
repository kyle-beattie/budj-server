import type { AccountType } from '../accounts/accounts.types.js';
import type { AkahuAccount } from './akahu.types.js';

/**
 * Translating Akahu's account vocabulary into ours. Pure, so the whole table
 * tests directly.
 *
 * Akahu's type list is wider than the local enum and **can grow without
 * notice**, so this maps what it knows and degrades everything else to `other`
 * rather than failing. One unrecognised account must never abort a sync that
 * would otherwise have imported nine good ones.
 */

const TYPE_MAP: Readonly<Record<string, AccountType>> = {
  CHECKING: 'checking',
  SAVINGS: 'savings',
  CREDITCARD: 'credit_card',
  LOAN: 'loan',
  INVESTMENT: 'investment',
  WALLET: 'cash',
  // A retirement investment; `investment` is the closest honest match.
  KIWISAVER: 'investment',
  // A savings product with a lock-up, not a distinct local concept.
  TERMDEPOSIT: 'savings',
  // FOREIGN, TAX and REWARDS are deliberately absent. Each *could* be forced
  // into a local type, but a foreign-currency account is not a cheque account
  // and a rewards balance is not money. `other` says "we do not model this",
  // which is true and stops a rule being written against a wrong assumption.
};

export function mapAccountType(akahuType: string): AccountType {
  return TYPE_MAP[akahuType.toUpperCase()] ?? 'other';
}

/**
 * Payment capability, in both directions.
 *
 * Both come straight from Akahu's `attributes`. Nothing is inferred: an earlier
 * design derived "can receive" from BECS identifiability, which was guesswork
 * standing in for a value Akahu already reports.
 *
 * The directions are genuinely independent — a credit card can commonly pay out
 * and can never receive — and the rule editor needs both before
 * `add-rule-triggers` exists.
 */
export function mapPaymentCapability(attributes: readonly string[]): {
  paymentFrom: boolean;
  paymentTo: boolean;
} {
  const upper = attributes.map((attribute) => attribute.toUpperCase());
  return {
    paymentFrom: upper.includes('PAYMENT_FROM'),
    paymentTo: upper.includes('PAYMENT_TO'),
  };
}

export interface ProjectedAccount {
  akahuAccountId: string;
  akahuConnectionId: string;
  connectionName: string;
  connectionLogo: string | null;
  name: string;
  type: AccountType;
  paymentFrom: boolean;
  paymentTo: boolean;
}

/**
 * Flatten one Akahu account into the row shape the projection stores.
 *
 * Note what is absent: no balance, no account number, no holder name. The
 * projection exists so Postgres can enforce tenancy over Akahu data, not to
 * mirror it.
 */
export function projectAccount(account: AkahuAccount): ProjectedAccount {
  const { paymentFrom, paymentTo } = mapPaymentCapability(account.attributes);

  return {
    akahuAccountId: account._id,
    akahuConnectionId: account.connection._id,
    connectionName: account.connection.name,
    connectionLogo: account.connection.logo ?? null,
    // Akahu can report an empty name; an empty string is preferable to
    // inventing one, and the client can fall back to the institution.
    name: account.name,
    type: mapAccountType(account.type),
    paymentFrom,
    paymentTo,
  };
}
