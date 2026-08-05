import { describe, expect, it } from 'vitest';
import { evaluateRules, matchesCondition } from '../src/modules/rules/rules.engine.js';
import type { Rule, TransactionCandidate } from '../src/modules/rules/rules.types.js';

const transaction: TransactionCandidate = {
  description: 'TESCO STORES 3421 LONDON',
  merchant: 'Tesco',
  amount: -42.5,
  accountId: '00000000-0000-4000-8000-000000000001',
  currency: 'GBP',
  reference: null,
};

function rule(overrides: Partial<Rule> & Pick<Rule, 'id' | 'name'>): Rule {
  return {
    userId: 'user_1',
    description: null,
    priority: 100,
    isEnabled: true,
    conditions: [],
    actions: [],
    stopProcessing: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('matchesCondition', () => {
  it('is case-insensitive by default', () => {
    expect(
      matchesCondition(transaction, {
        field: 'description',
        operator: 'contains',
        value: 'tesco',
        caseSensitive: false,
      }),
    ).toBe(true);
  });

  it('respects caseSensitive', () => {
    expect(
      matchesCondition(transaction, {
        field: 'description',
        operator: 'contains',
        value: 'tesco',
        caseSensitive: true,
      }),
    ).toBe(false);
  });

  it('compares amounts numerically', () => {
    expect(
      matchesCondition(transaction, {
        field: 'amount',
        operator: 'lt',
        value: 0,
        caseSensitive: false,
      }),
    ).toBe(true);
  });

  it('returns false for an invalid regex instead of throwing', () => {
    expect(
      matchesCondition(transaction, {
        field: 'description',
        operator: 'matches',
        value: '([unclosed',
        caseSensitive: false,
      }),
    ).toBe(false);
  });

  it('does not match when the field is null', () => {
    expect(
      matchesCondition(transaction, {
        field: 'reference',
        operator: 'contains',
        value: 'anything',
        caseSensitive: false,
      }),
    ).toBe(false);
  });
});

describe('evaluateRules', () => {
  it('applies matching rules in priority order, last write wins', () => {
    const result = evaluateRules(transaction, [
      rule({
        id: '00000000-0000-4000-8000-00000000000b',
        name: 'specific',
        priority: 20,
        conditions: [
          { field: 'merchant', operator: 'equals', value: 'Tesco', caseSensitive: false },
        ],
        actions: [
          { type: 'set_category', category: 'Groceries' },
          { type: 'add_tags', tags: ['supermarket'] },
        ],
      }),
      rule({
        id: '00000000-0000-4000-8000-00000000000a',
        name: 'catch-all',
        priority: 10,
        conditions: [{ field: 'amount', operator: 'lt', value: 0, caseSensitive: false }],
        actions: [{ type: 'set_category', category: 'Uncategorised' }],
      }),
    ]);

    expect(result.matched.map((m) => m.name)).toEqual(['catch-all', 'specific']);
    expect(result.outcome.category).toBe('Groceries');
    expect(result.outcome.tags).toEqual(['supermarket']);
  });

  it('halts on stopProcessing', () => {
    const result = evaluateRules(transaction, [
      rule({
        id: '00000000-0000-4000-8000-00000000000c',
        name: 'first',
        priority: 1,
        stopProcessing: true,
        conditions: [{ field: 'currency', operator: 'equals', value: 'GBP', caseSensitive: false }],
        actions: [{ type: 'set_category', category: 'Groceries' }],
      }),
      rule({
        id: '00000000-0000-4000-8000-00000000000d',
        name: 'never reached',
        priority: 2,
        conditions: [{ field: 'currency', operator: 'equals', value: 'GBP', caseSensitive: false }],
        actions: [{ type: 'set_category', category: 'Other' }],
      }),
    ]);

    expect(result.matched).toHaveLength(1);
    expect(result.outcome.category).toBe('Groceries');
  });

  it('skips disabled rules and rules with no conditions', () => {
    const result = evaluateRules(transaction, [
      rule({
        id: '00000000-0000-4000-8000-00000000000e',
        name: 'disabled',
        isEnabled: false,
        conditions: [{ field: 'currency', operator: 'equals', value: 'GBP', caseSensitive: false }],
        actions: [{ type: 'ignore' }],
      }),
      rule({ id: '00000000-0000-4000-8000-00000000000f', name: 'no conditions' }),
    ]);

    expect(result.matched).toHaveLength(0);
    expect(result.outcome.ignored).toBe(false);
  });

  it('requires every condition on a rule to hold', () => {
    const result = evaluateRules(transaction, [
      rule({
        id: '00000000-0000-4000-8000-000000000010',
        name: 'and',
        conditions: [
          { field: 'merchant', operator: 'equals', value: 'Tesco', caseSensitive: false },
          { field: 'amount', operator: 'gt', value: 0, caseSensitive: false },
        ],
        actions: [{ type: 'set_category', category: 'Income' }],
      }),
    ]);

    expect(result.matched).toHaveLength(0);
  });
});
