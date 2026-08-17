import { z } from 'zod';

/**
 * Akahu's wire shapes — only the parts this server reads.
 *
 * Validated with Zod rather than trusted as typed JSON. Akahu is an external
 * system that can add fields, change enums, and return partial data when an
 * institution is degraded; the projection has to survive all of that.
 */

/**
 * The five scopes from D7, chosen once and deliberately.
 *
 * Widening this later costs a bank redirect for every existing user, which is
 * why `accounts:owner` is requested now — `add-rule-triggers` needs it to
 * generate account verification tokens, and asking then would mean sending
 * everyone back through their bank.
 *
 * `transactions:credits` and `transactions:debits` **must be requested as a
 * pair** even though only credits matter to the product. Privacy copy should
 * say so, along with the fact that neither is stored.
 *
 * `accounts:balance` and `payments` are absent, and a test asserts it. Nothing
 * reads a balance, and this change does not move money.
 */
export const AKAHU_SCOPES = [
  'accounts:basic',
  'accounts:owner',
  'transactions:credits',
  'transactions:debits',
  'user:basic',
] as const;

export type AkahuScope = (typeof AKAHU_SCOPES)[number];

/** Akahu's account type vocabulary. Wider than ours, and it can grow. */
export const akahuAccountTypes = [
  'CHECKING',
  'SAVINGS',
  'CREDITCARD',
  'LOAN',
  'KIWISAVER',
  'INVESTMENT',
  'TERMDEPOSIT',
  'FOREIGN',
  'TAX',
  'REWARDS',
  'WALLET',
] as const;

/**
 * Capability attributes Akahu reports per account.
 *
 * Both payment directions come straight from here. An earlier design inferred
 * "can receive" from BECS identifiability; Akahu reports `PAYMENT_TO`
 * directly, so there is nothing to infer.
 */
export const akahuAttributes = ['TRANSACTIONS', 'PAYMENT_TO', 'PAYMENT_FROM'] as const;

export const akahuConnectionSchema = z.object({
  _id: z.string().min(1),
  name: z.string().default(''),
  logo: z.string().optional(),
});
export type AkahuConnection = z.infer<typeof akahuConnectionSchema>;

/**
 * An Akahu account, as far as this server is concerned.
 *
 * **`balance` is deliberately not modelled.** Akahu may return it, and Zod
 * strips unknown keys by default, so a balance cannot reach the projection even
 * by accident. Storing one is the single most sensitive thing this codebase
 * could do and it is stale the moment it is written (D6).
 */
export const akahuAccountSchema = z.object({
  _id: z.string().min(1),
  name: z.string().default(''),
  // Not an enum: an unrecognised type must degrade, never fail the parse.
  type: z.string().default(''),
  status: z.string().optional(),
  attributes: z.array(z.string()).default([]),
  connection: akahuConnectionSchema,
});
export type AkahuAccount = z.infer<typeof akahuAccountSchema>;

export const akahuAccountsResponseSchema = z.object({
  success: z.boolean().optional(),
  items: z.array(akahuAccountSchema).default([]),
});

/** `POST /v1/token` — note `error`, not `message`, unlike every other endpoint. */
export const akahuTokenResponseSchema = z.object({
  success: z.boolean().optional(),
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  scope: z.string().optional(),
});

/** `POST /v1/par` — Akahu builds the authorisation URL, we do not. */
export const akahuParResponseSchema = z.object({
  success: z.boolean().optional(),
  request_uri: z.string().optional(),
  authorisation_url: z.string().min(1),
  expires_in: z.number().int().optional(),
});

export const akahuMeResponseSchema = z.object({
  success: z.boolean().optional(),
  item: z.object({ _id: z.string().min(1) }).optional(),
});
