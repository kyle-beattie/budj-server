import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  centsToDecimal,
  decimalToCents,
  isValidMoneyString,
  MoneyFormatError,
} from '../src/lib/money.js';

describe('decimalToCents', () => {
  it.each([
    ['0.00', 0],
    ['0.01', 1],
    ['1.00', 100],
    ['12.34', 1234],
    ['-5.60', -560],
    ['999999999999.99', 99999999999999],
  ])('parses %s to %d cents', (decimal, cents) => {
    expect(decimalToCents(decimal)).toBe(cents);
  });

  /**
   * The whole reason this function exists rather than arithmetic on a float.
   * `parseFloat('0.29') * 100` is 28.999999999999996, so an implementation that
   * truncates loses a cent — on some values and not others, which is the worst
   * way to be wrong. Each case below asserts both the right answer and that the
   * naive approach gets it wrong, so the trap cannot quietly stop being a trap.
   */
  it.each([
    ['0.29', 29],
    ['4.35', 435],
    ['1.15', 115],
    ['9.95', 995],
    ['1.13', 113],
    ['2.03', 203],
    ['0.57', 57],
  ])('parses %s exactly where binary floating point does not', (decimal, cents) => {
    expect(decimalToCents(decimal)).toBe(cents);
    // Demonstrate the trap rather than assert it in a comment.
    expect(Math.trunc(Number.parseFloat(decimal) * 100)).not.toBe(cents);
  });

  /** One decimal place is tenths, not hundredths. */
  it.each([
    ['0.1', 10],
    ['1.5', 150],
    ['5', 500],
  ])('pads %s to %d cents', (decimal, cents) => {
    expect(decimalToCents(decimal)).toBe(cents);
  });

  /**
   * Deliberately strict. Rounding is a decision about someone's money, and
   * making it silently here would hide the bug that produced the third digit.
   */
  it.each([
    ['2.675'],
    ['1.005'],
    ['1.2.3'],
    [''],
    [' 1.00'],
    ['1.00 '],
    ['+1.00'],
    ['1e2'],
    ['NaN'],
    ['Infinity'],
    ['1,234.00'],
    ['$1.00'],
    ['1234567890123.00'],
  ])('rejects %s', (decimal) => {
    expect(() => decimalToCents(decimal)).toThrow(MoneyFormatError);
  });

  it('rejects a non-string', () => {
    expect(() => decimalToCents(12.34 as unknown as string)).toThrow(MoneyFormatError);
  });
});

describe('centsToDecimal', () => {
  it.each([
    [0, '0.00'],
    [1, '0.01'],
    [100, '1.00'],
    [1234, '12.34'],
    [-560, '-5.60'],
    [7, '0.07'],
  ])('formats %d as %s', (cents, decimal) => {
    expect(centsToDecimal(cents)).toBe(decimal);
  });

  it('always emits two decimal places', () => {
    expect(centsToDecimal(150)).toBe('1.50');
    expect(centsToDecimal(10)).toBe('0.10');
  });

  it('rejects a fractional cent', () => {
    expect(() => centsToDecimal(1.5)).toThrow(MoneyFormatError);
  });
});

describe('round tripping', () => {
  it.each([['0.00'], ['0.01'], ['8.16'], ['12.34'], ['-5.60'], ['999999999999.99']])(
    '%s survives a round trip',
    (decimal) => {
      expect(centsToDecimal(decimalToCents(decimal))).toBe(decimal);
    },
  );

  it('canonicalises a short fraction on the way back', () => {
    expect(centsToDecimal(decimalToCents('0.1'))).toBe('0.10');
    expect(centsToDecimal(decimalToCents('5'))).toBe('5.00');
  });
});

/**
 * Task 10.6: the published vectors are asserted against this server's own
 * implementation, so drift fails **here** rather than in a Swift client that
 * nobody is running the server's tests against.
 */
describe('contract/money-vectors.json', () => {
  const vectors = JSON.parse(
    readFileSync(resolve(process.cwd(), 'contract/money-vectors.json'), 'utf8'),
  ) as {
    valid: Array<{ decimal: string; cents: number; canonical: string }>;
    invalid: Array<{ decimal: string }>;
  };

  it('is not empty in either direction', () => {
    expect(vectors.valid.length).toBeGreaterThan(5);
    expect(vectors.invalid.length).toBeGreaterThan(5);
  });

  it('agrees with the server on every valid vector', () => {
    for (const vector of vectors.valid) {
      expect(decimalToCents(vector.decimal)).toBe(vector.cents);
      expect(centsToDecimal(vector.cents)).toBe(vector.canonical);
    }
  });

  it('agrees with the server on every invalid vector', () => {
    for (const vector of vectors.invalid) {
      expect(isValidMoneyString(vector.decimal)).toBe(false);
      expect(() => decimalToCents(vector.decimal)).toThrow(MoneyFormatError);
    }
  });

  /** The vectors are worthless if they do not include the float traps. */
  it('includes cases that a naive float implementation fails', () => {
    const traps = vectors.valid.filter(
      (vector) => Math.trunc(Number.parseFloat(vector.decimal) * 100) !== vector.cents,
    );

    expect(traps.length).toBeGreaterThan(0);
  });
});
