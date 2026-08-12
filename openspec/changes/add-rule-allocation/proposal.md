## Why

`add-rule-triggers` gives a rule a flat list of effects, each computed
independently from the triggering transaction. That is enough to say "move 10% of
my salary to Savings". It cannot say what people actually do with income:

```
  $1,150 arrives from a client
    take the GST out           $150.00   → GST account
    of what's left, 33% is tax $330.00   → Tax account
    then $200 to savings       $200.00   → Savings
    the rest stays put         $470.00
```

Every line after the first is a fraction *of the remainder*, not of the original.
Expressed as independent percentages of the trigger, the user has to do the
arithmetic themselves — 33% of the post-GST amount is 28.7% of the original — and
redo it whenever any earlier line changes. That is precisely the calculation
people get wrong, and getting it wrong here moves the wrong amount of real money.

**The problem this change solves is that the user should never have to hold the
arithmetic in their head.** Everything below follows from that: a rule becomes an
ordered sequence of steps that consume from a running remainder, and the authoring
surface resolves every step to a dollar figure while it is being written.

## What Changes

- **BREAKING: a rule's flat effect list becomes an ordered step list.** Steps run
  in the order written, each consuming from a running remainder that starts at
  the trigger amount. `add-rule-triggers` has not shipped, so this replaces its
  effect list rather than migrating it.
- **Amount forms.** `fixed`, `percent` of `original` or `remaining`, `fraction`
  (numerator and denominator, so GST at any rate is exact), and `remainder`.
- **The remainder is arithmetic, not a recomputation.** It is the trigger amount
  minus everything allocated so far, in integer cents, so round-down dust cannot
  accumulate or vanish.
- **A step that does not fit is skipped, not shrunk.** Moving less than the user
  wrote is never correct. The skip is surfaced in the proposal before approval.
- **The unallocated tail is a displayed outcome**, not an implementation detail.
- **Authoring-time resolution.** `POST /api/rules/evaluate` becomes a preview that
  resolves a draft rule against a supplied amount, returning every step's
  computed figure, the running remainder, the tail, and any step that would be
  skipped. This is the server half of the canvas.
- **A loop guard.** A transfer this service initiates settles at the bank and
  returns as a credit webhook. With waterfalls that is a payment loop, so
  ingestion must never propose against a transfer this system initiated.

## Capabilities

### New Capabilities

- `rule-allocation`: The ordered step list, the amount forms, remainder
  arithmetic in integer cents, round-down dust to the tail, skip-on-insufficient,
  and the conservation property.
- `flow-authoring`: The preview endpoint contract — resolving a draft rule against
  a hypothetical amount so that every figure the canvas displays comes from the
  same evaluator that will run in production.

### Modified Capabilities

- `rule-effects`: `transfer` gains the amount forms and loses the bare percentage.
  Consent-limit validation at rule creation must reason about the largest amount a
  *sequence* can produce rather than a single effect.
- `execution-approval`: A proposal carries per-step resolved amounts, skipped
  steps with their reasons, and the unallocated tail, because the approval screen
  shows the same waterfall the canvas did.
- `transaction-ingestion`: Transfers initiated by this service are excluded from
  proposal generation when they return as webhook events.

## Impact

**No new tables.** Steps live in the existing `rules.actions` jsonb, renamed and
reshaped; the resolved figures live in `pending_executions.effects`, which already
carries per-effect status.

**The engine stops being a fold and becomes a sequence.** `evaluateRules` currently
folds every matching rule's actions into one outcome. Steps are ordered *within* a
rule and consume shared state, so evaluation becomes a left scan over steps with
an accumulator. Rules still fold across each other in priority order, and
`stopProcessing` is unchanged.

**The evaluator is the canvas's source of truth.** Two implementations of this
arithmetic — one on the server, one in the app for live preview — will drift, and
the failure mode is a canvas that shows a number different from the one that
executes. The preview endpoint exists so that does not happen.

**Risk.** This change decides how much money moves. The arithmetic is small,
total, and pure, which makes exhaustive property testing cheap — and mandatory.

## Not In Scope

- **Per-step conditions** ("only if the remainder exceeds $500"). This is
  Shortcuts' `If` block; it turns a sequence into a tree and can wait for real
  demand.
- **Steps reused across rules.** Considered and rejected: the reuse case that
  motivated it turned out to be a single generalised example, not a requirement.
- **Rules invoking other rules.** The rejected Model 1 in `design.md`. It is also
  the only construct in this design that could form a cycle.
