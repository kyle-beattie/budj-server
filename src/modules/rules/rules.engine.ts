import type {
  EvaluateRulesResult,
  Rule,
  RuleAction,
  RuleCondition,
  TransactionCandidate,
} from './rules.types.js';

function readField(transaction: TransactionCandidate, field: RuleCondition['field']): string | number | null {
  switch (field) {
    case 'description':
      return transaction.description;
    case 'merchant':
      return transaction.merchant ?? null;
    case 'amount':
      return transaction.amount;
    case 'accountId':
      return transaction.accountId ?? null;
    case 'currency':
      return transaction.currency;
    case 'reference':
      return transaction.reference ?? null;
  }
}

function compareNumeric(actual: string | number | null, expected: string | number): number | null {
  const left = typeof actual === 'number' ? actual : Number(actual);
  const right = typeof expected === 'number' ? expected : Number(expected);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return left - right;
}

export function matchesCondition(
  transaction: TransactionCandidate,
  condition: RuleCondition,
): boolean {
  const actual = readField(transaction, condition.field);
  if (actual === null) return false;

  const normalise = (value: string | number): string =>
    condition.caseSensitive ? String(value) : String(value).toLowerCase();

  const left = normalise(actual);
  const right = normalise(condition.value);

  switch (condition.operator) {
    case 'equals':
      return left === right;
    case 'not_equals':
      return left !== right;
    case 'contains':
      return left.includes(right);
    case 'not_contains':
      return !left.includes(right);
    case 'starts_with':
      return left.startsWith(right);
    case 'ends_with':
      return left.endsWith(right);
    case 'matches': {
      try {
        return new RegExp(String(condition.value), condition.caseSensitive ? '' : 'i').test(String(actual));
      } catch {
        // An invalid pattern must not take down evaluation for every other rule.
        return false;
      }
    }
    case 'gt': {
      const diff = compareNumeric(actual, condition.value);
      return diff !== null && diff > 0;
    }
    case 'gte': {
      const diff = compareNumeric(actual, condition.value);
      return diff !== null && diff >= 0;
    }
    case 'lt': {
      const diff = compareNumeric(actual, condition.value);
      return diff !== null && diff < 0;
    }
    case 'lte': {
      const diff = compareNumeric(actual, condition.value);
      return diff !== null && diff <= 0;
    }
  }
}

/** All conditions must hold for the rule to fire. */
export function matchesRule(transaction: TransactionCandidate, rule: Rule): boolean {
  if (!rule.isEnabled) return false;
  if (rule.conditions.length === 0) return false;
  return rule.conditions.every((condition) => matchesCondition(transaction, condition));
}

function applyAction(outcome: EvaluateRulesResult['outcome'], action: RuleAction): void {
  switch (action.type) {
    case 'set_category':
      outcome.category = action.category;
      break;
    case 'add_tags':
      for (const tag of action.tags) {
        if (!outcome.tags.includes(tag)) outcome.tags.push(tag);
      }
      break;
    case 'set_account':
      outcome.accountId = action.accountId;
      break;
    case 'set_note':
      outcome.note = action.note;
      break;
    case 'ignore':
      outcome.ignored = true;
      break;
  }
}

/**
 * Runs `rules` against a transaction in priority order (lowest first) and folds
 * every matching rule's actions into a single outcome. Pure — no I/O, no clock.
 */
export function evaluateRules(
  transaction: TransactionCandidate,
  rules: Rule[],
): EvaluateRulesResult {
  const ordered = [...rules].sort(
    (a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt),
  );

  const outcome: EvaluateRulesResult['outcome'] = {
    category: null,
    tags: [],
    accountId: null,
    note: null,
    ignored: false,
  };
  const matched: EvaluateRulesResult['matched'] = [];

  for (const rule of ordered) {
    if (!matchesRule(transaction, rule)) continue;

    matched.push({ ruleId: rule.id, name: rule.name, actions: rule.actions });
    for (const action of rule.actions) applyAction(outcome, action);

    if (rule.stopProcessing) break;
  }

  return { matched, outcome };
}
