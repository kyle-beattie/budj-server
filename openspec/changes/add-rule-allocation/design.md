## Context

`add-rule-triggers` establishes the machinery: a transaction arrives by webhook,
matching rules produce one proposal, the owner approves, money moves. Its effect
model is a flat list — each `transfer` computed independently from the trigger
amount.

Real allocation is not flat. Income arrives gross and is divided in sequence,
each division taking from what the previous one left:

```
  ┌ TRIGGER ──────────────────────────┐
  │ credit ≥ $1,150.00                │
  │ into Business · from "ACME LTD"   │
  └──────────────┬────────────────────┘
                 │  $1,150.00
  ┌ STEP 1 ──────▼────────────────────┐
  │ GST — 3/23 of original            │
  │ $150.00  →  GST account           │
  └──────────────┬────────────────────┘
                 │  $1,000.00 remaining
  ┌ STEP 2 ──────▼────────────────────┐
  │ 33% of remaining                  │
  │ $330.00  →  Tax account           │
  └──────────────┬────────────────────┘
                 │  $670.00 remaining
  ┌ STEP 3 ──────▼────────────────────┐
  │ Fixed amount                      │
  │ $200.00  →  Savings               │
  └──────────────┬────────────────────┘
                 │  $470.00 unallocated
                 ▼  stays in Business
```

That picture is the specification. The user reads down the left edge and sees
what happens to their money without computing anything. Every decision below is
in service of making that display truthful.

## Goals / Non-Goals

**Goals:**

- A user writing a rule sees resolved dollar amounts for every step, and the
  running remainder between them, at authoring time and at approval time.
- The figures shown and the figures executed are produced by the same evaluator.
- No sequence, however written, can allocate more than the transaction brought in.
- Rounding is exhaustively specified: no cent is created, lost, or misplaced.

**Non-Goals:**

- Per-step conditions. Shortcuts' `If` turns the sequence into a tree; deferred.
- Steps shared between rules, or rules invoking rules. See A1.
- Multi-currency arithmetic. A rule operates in the trigger account's currency.
- Scheduling — "move $200 on the 1st" is a different trigger, not an allocation.

## Decisions

### A1. A rule *is* the flow; steps are not rules

The requested shape was "rules trigger other rules", drawn as a flow canvas. Two
models satisfy that description and they are not equally good:

```
  MODEL 1 — standalone rules + edges        MODEL 2 — one rule, ordered steps
  ────────────────────────────────────      ────────────────────────────────
  ┌──────┐  then  ┌──────┐  then            ┌ Rule "ACME payment" ─────┐
  │ GST  │───────▶│ Tax  │───────▶ …        │  trigger: conditions     │
  │ rule │        │ rule │                  │  ① GST ② Tax ③ Savings   │
  └──────┘        └──────┘                  └──────────────────────────┘
     ▲               ▲
     │               └─ has conditions. does it also match alone?
     └─ delete it and Tax is orphaned
```

Model 2 is adopted. Model 1's flaw is not cycles — a linear chain has none — but
that a chain *step* and a *trigger* are different things wearing one type. "Move
33% to tax" has no meaningful standalone trigger; as a rule it must either match
transactions independently (wrong) or carry a "chain-only, do not match" flag, at
which point there are two kinds of rules, and the canvas must render both plus
edges, orphans on delete, and reachability during the fold.

Model 2 also matches the intended UI more closely than it first appears. iOS
Shortcuts, the reference, is not a graph: it is an ordered stack of cards with one
value flowing down. The canvas above is that stack.

What Model 1 buys over Model 2 is step reuse across triggers and branching.
Neither is required — the "sweep the rest to Operating" example that suggested
reuse was a generalisation of a sequence of distinct arithmetic, not a shared
step. Recorded so this is not re-litigated: **if reuse or branching becomes a
real requirement, Model 1 is the thing to reach for, and the cost is the two-kinds
-of-rules problem above, not the graph.**

### A2. Steps consume a running remainder; the trigger amount stays immutable

Evaluation carries two registers alongside the immutable trigger facts:

```
  trigger facts (immutable)          registers (per proposal)
  ─────────────────────────          ────────────────────────
  amount     115000 ¢                allocated  0 → 15000 → 48000 → 68000
  direction  credit                  remaining  115000 → 100000 → 67000 → 47000
  merchant   ACME LTD                             ▲
  accountId  Business                             └─ integer cents, by subtraction
```

`amount` is never overwritten. A rule reading "when $1,150 arrives" must keep
matching after an earlier step has run, and a step may legitimately want a
percentage of the original rather than the remainder.

**`remaining` is the trigger amount minus everything allocated so far — computed
by subtraction, never recomputed as a percentage.** This is what makes the
waterfall conserve exactly under E3's round-down rule:

```
  gross $1,000.00 (100000¢)
  ─────────────────────────────────────────────────────────────
  ① 3/23 of original    100000×3/23 = 13043.478…  → 13043¢   $130.43
                        remaining 100000−13043    =  86957¢
  ② 33% of remaining     86957×33/100 = 28695.81  → 28695¢   $286.95
                        remaining  86957−28695    =  58262¢
  ③ fixed $200.00                                    20000¢   $200.00
                        remaining  58262−20000    =  38262¢
                                                     ───────
  allocated 61738¢ + tail 38262¢ = 100000¢          exact
```

Recomputing `remaining` from percentages instead would let the dust drift; taking
it by subtraction cannot.

### A3. Allocation is exclusive: the first matching rule with steps owns the transaction

If two matching rules both allocate, whose remainder is it? Three answers:

| | Conservation | Canvas truthfulness | Surprise |
| --- | --- | --- | --- |
| Shared register across the fold | ✅ holds globally | ❌ a rule's preview is wrong whenever another also matches | ordering silently changes amounts |
| Per-rule register | ❌ two rules can each allocate 100% | ✅ always right | over-allocation |
| **Exclusive (adopted)** | ✅ trivially | ✅ always right | second rule does not run |

The first matching rule carrying `transfer` steps handles the transaction; later
matching rules' `transfer` steps are skipped. Non-allocating effects (`notify`,
`ignore`) continue to fold across all matching rules exactly as
`add-rule-triggers` specifies, so `ignore` at priority 0 still suppresses
everything.

This is implicit `stopProcessing` for money, and it is what makes the canvas
honest: a rule always sees the full trigger amount, so what it displays while
being authored is what it will compute in production. The alternative — a shared
register — means the number on the card depends on rules the user is not
currently looking at, which reintroduces exactly the mental arithmetic this change
exists to remove.

The cost is a silently unrun second rule, so it is not silent: the proposal
records the skipped rule and the one that claimed the transaction, and the
approval screen shows it.

### A4. Four amount forms, no expression language

```
  fixed      { cents }                     $200.00
  percent    { value, of: original|remaining }   33% of remaining
  fraction   { numerator, denominator, of }      3/23 of original   ← GST, exact
  remainder  { }                                 whatever is left
```

`fraction` exists because GST is the motivating case and `0.130434…%` is not a
number a person should type. At 15% inclusive it is exactly `3/23`; at any other
rate it is exactly `r/(100+r)`. Expressed as a fraction the arithmetic is one
multiply and one divide on `bigint` cents, exact until the final round-down.

A general expression language was rejected. It would need a parser, precedence,
division-by-zero handling, and a time budget — the same class of liability as the
`matches` regex operator, which `add-rule-triggers` is already having to bound.
Four closed forms cover the motivating case and every variant volunteered so far.

`percent` **must** name its base. A bare percentage is ambiguous the moment
remainders exist — 33% of the post-GST amount is 28.7% of the original — and a
stored rule whose base is implied is a rule whose meaning can be reinterpreted
later. This mirrors E2: `direction` is stored, not inferred from a sign.

`remainder` is what guarantees the tail lands somewhere when a user wants
everything allocated. It is also the only form that can produce zero without
being an error.

### A5. Dust goes to the tail

Round-down is inherited from E3 and applies per step. The cents lost to rounding
accumulate in `remaining` and end up in the unallocated tail, or in a final
`remainder` step if the user wrote one.

The alternative — distributing dust across steps to make them sum exactly, as a
payroll system might — is rejected. It would move an amount the canvas did not
display, and "the number you saw is the number that moves" outranks tidiness by
one or two cents.

### A6. A step that does not fit is skipped, and the skip is visible before approval

A fixed $200 step with $150 remaining does not become a $150 step. Moving less
than the user wrote is silently substituting a different instruction.

```
  ③ Fixed $200.00 → Savings     ⚠ SKIPPED — $150.00 remaining
```

Because the whole sequence is one approval (E4), the user sees the skip and can
decline. The skip is recorded per step in the proposal with its reason, alongside
the per-effect status `add-rule-triggers` already provides.

A `percent` or `fraction` step cannot fail to fit when its base is `remaining`,
and can when its base is `original` — two 60%-of-original steps need 120%. That
case is the reason authoring-time preview (A7) matters rather than being a
nicety.

### A7. The preview endpoint is the canvas, and it is the same evaluator

`POST /api/rules/evaluate` becomes a resolution endpoint: given a draft rule and a
hypothetical amount, return every step's computed cents, the running remainder
after each, the tail, and any step that would be skipped and why.

```
  ┌ Preview with ─────────────────┐
  │  $ 1,150.00      ◀ editable   │
  └───────────────────────────────┘
  ① 60% of original    $690.00   ✓   remaining $460.00
  ② 60% of original    $690.00   ⚠   won't fit — skipped
```

Two reasons this is server-side rather than a client-side mirror:

**Drift.** The app and the server would each implement round-down, subtraction
order, and skip semantics. When they disagree the canvas shows one number and the
bank moves another, and the user approved the first. A second implementation of
money arithmetic is a liability with no offsetting benefit.

**It is the same code path.** The preview calls the same pure evaluator that
ingestion calls. A property test asserting `preview(amount) == proposal(amount)`
is therefore cheap and worth having as a permanent guard.

The endpoint takes a *draft* — an unsaved rule body — so the canvas resolves
while the user types, before anything is stored.

**The preview amount cannot be defaulted from history.** This product stores no
transaction amounts, deliberately (E8, and the ingestion requirement that no
Akahu facts are persisted). So the canvas cannot open with "your last payment
from ACME". Default instead to the rule's own `amount gte`/`gt` condition value
where one exists, and otherwise require the user to type a figure. Worth stating
because the obvious implementation is the one the privacy posture forbids.

### A8. The bank feed is the cycle, not the steps

A linear step list cannot loop. The loop is external:

```
  ACME $1,150 → Business ──step──▶ $150 → GST account
                                          │
                                    settles at the bank
                                          │
                                    Akahu webhook: credit on GST account
                                          │
                                    rules evaluated again ──▶ ?
```

`add-rule-triggers` E1 offers a priority-0 `ignore` rule for internal transfers as
a user-authored answer. With waterfalls that is too weak: a rule allocating out of
an account that another rule pays into is a payment loop, bounded only by the
consent limits, and it depends on the user having written the right `ignore`.

Structural guard instead: **ingestion never proposes against a transaction this
service initiated.** E7 already puts a `sid` reference in the payer's particulars
for reconciliation; the same reference identifies the returning credit. The
user-authored `ignore` rule remains useful for genuinely manual internal
transfers.

### A9. Ordering is the array, and nothing else

Steps execute in written order. There is no per-step priority, no sort key, no
tie-break. The canvas is a vertical list and reordering is drag-and-drop; any
second ordering mechanism would let the displayed order differ from the executed
order, which is the one bug this design cannot tolerate.

Rules continue to order among themselves by `priority` then `createdAt`, unchanged.

## Risks / Trade-offs

**The displayed number and the executed number diverge.** The entire value
proposition. → One evaluator (A7), a property test tying preview to proposal, and
resolved amounts stored on the proposal at creation (E8) rather than recomputed at
approval.

**Rounding.** Three forms, a round-down rule, and a tail. → Exhaustive property
tests: allocations plus tail always equal the trigger amount, exactly, for every
sequence and every amount tested; no step ever exceeds its remaining base.

**A silently skipped second allocation rule (A3).** A user with two overlapping
income rules sees one run. → Recorded on the proposal and shown; warn at authoring
time when another enabled rule's conditions could also match.

**Consent-limit validation gets harder.** `add-rule-triggers` warns when a single
transfer could exceed the consent's single-payment limit. A sequence needs the
largest amount any *step* could produce, and the periodic limit now sees several
payments per trigger rather than one. → Compute both bounds from the step list at
creation; percentage-of-remaining steps are bounded by the trigger amount, so the
bound exists even when it is loose.

**More payments per approval.** Four steps is four `POST /payments` calls where
there was one. Each can fail independently, which the per-effect status already
models, but partial failure of a waterfall is more confusing than partial failure
of a flat list — "the GST went out, the tax did not". → The approval screen and
the activity feed present the sequence as a sequence, not as unrelated payments.

**A step whose destination consent is revoked mid-sequence.** → Inherits E14: the
pending execution is invalidated as a whole. A half-executed waterfall is worse
than one that did not run.

## Migration Plan

Sequenced after `add-rule-triggers` sections 2 and 3, and before its section 7 —
the arithmetic should be settled before anything can pay.

1. Money helpers extended: `fraction` and percentage-of-base on `bigint` cents,
   with the property tests. Pure, so provable in isolation.
2. The step schema replaces the effect list. `add-rule-triggers` has not shipped,
   so no stored rule needs migrating — this is the last moment that is true.
3. The evaluator becomes a left scan with the two registers. Exclusive allocation
   (A3), skip-on-insufficient (A6), tail (A5).
4. Preview endpoint over the same evaluator, plus the equivalence property test.
5. Proposal shape: per-step resolved amounts, skips with reasons, tail.
6. The `sid` loop guard in ingestion (A8).
7. Consent-limit bounds recomputed from step lists.
8. `CLAUDE.md`: the engine is a scan, not a fold; the preview endpoint is the
   canvas's source of truth and must not be mirrored client-side.

## Open Questions

1. **Is exclusive allocation (A3) right?** It is the decision most likely to
   surprise. The alternative is a shared register across matching rules, which
   conserves globally but makes a rule's preview depend on rules the user is not
   looking at. Confirm against the intended UI before building.
2. **Should the canvas expose `fraction` directly, or as a labelled "GST" step
   with a rate?** The primitive is `3/23`; the concept the user has is "15% GST,
   inclusive". A UI affordance that emits a fraction is probably right, but that
   is a client decision the server should not constrain.
3. **What bounds a percentage-of-remaining step for consent validation?** The
   trigger amount bounds it, but that bound is loose enough to warn on nearly
   every rule. Needs a judgement about warning fatigue.
4. **Does the activity feed name steps?** "Payday rule → moved $150 to GST, $330
   to Tax" is more useful than four separate lines, and the rule name alone
   (E8) may no longer carry enough meaning once a rule does four things.
