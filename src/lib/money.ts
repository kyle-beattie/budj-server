/**
 * Money as a decimal string, and the one safe way to turn it into an integer.
 *
 * Postgres stores money as `numeric(14,2)` and PostgREST returns it as a
 * string. It stays a string through the DTOs and out over the wire, so nothing
 * in this server ever holds an amount in a float.
 *
 * The reason this file exists is the *client*. OpenAPI types money as `string`,
 * and nothing in a generated Swift client stops someone writing
 * `Double(amountString)` — which reintroduces, on the screen where a person
 * approves a payment, exactly the problem this codebase went to some effort to
 * remove. `contract/money-vectors.json` is generated from these rules and
 * shipped so the client can prove it agrees.
 */

/** `numeric(14,2)`: twelve digits before the point, two after. */
const MONEY_PATTERN = /^-?\d{1,12}(\.\d{1,2})?$/;

export class MoneyFormatError extends Error {
  constructor(value: string) {
    super(`'${value}' is not a valid decimal money string`);
    this.name = 'MoneyFormatError';
  }
}

/**
 * Parse a decimal money string into whole cents.
 *
 * Deliberately **strict**: three decimal places is rejected rather than
 * rounded. A rounding rule is a decision about someone's money, and silently
 * making it here would hide a bug in whatever produced the third digit.
 *
 * Done by string manipulation, never arithmetic on a float.
 * `parseFloat("0.29") * 100` is `28.999999999999996` and
 * `parseFloat("4.35") * 100` is `434.99999999999994`, so an implementation that
 * truncates loses a cent — on some values and not others, which is the worst
 * way to be wrong. `contract/money-vectors.json` ships those cases so the iOS
 * client can prove it agrees.
 */
export function decimalToCents(value: string): number {
  if (typeof value !== 'string' || !MONEY_PATTERN.test(value)) {
    throw new MoneyFormatError(String(value));
  }

  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.') as [string, string?];

  // Pad rather than parse: '1.5' is 150 cents, not 15.
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));

  return negative ? -cents : cents;
}

/** The inverse. Always two decimal places, so the output round-trips. */
export function centsToDecimal(cents: number): string {
  if (!Number.isInteger(cents)) {
    throw new MoneyFormatError(String(cents));
  }

  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const whole = Math.floor(absolute / 100);
  const fraction = absolute % 100;

  return `${negative ? '-' : ''}${whole}.${String(fraction).padStart(2, '0')}`;
}

export function isValidMoneyString(value: string): boolean {
  return typeof value === 'string' && MONEY_PATTERN.test(value);
}
