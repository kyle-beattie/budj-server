## 1. Unblock

- [ ] 1.1 Confirm exclusive allocation (A3): the first matching rule with
      transfer steps owns the transaction, later ones are skipped. This is the
      decision most likely to surprise, and it is cheaper to change now than
      after the canvas is built against it.
- [ ] 1.2 Land the `of` hook in `add-rule-triggers` before that change ships —
      `percent` must name its base (`original` | `remaining`) even while
      `remaining` has no meaning yet. Afterwards it is a jsonb migration over
      live rules.
- [ ] 1.3 Decide whether the canvas exposes `fraction` raw or as a labelled GST
      step with a rate (open question 2). Server emits a fraction either way; this
      only needs settling so the client and server agree on what is stored.

## 2. The arithmetic, proven in isolation

Pure, total, and small. All of section 2 is provable before any integration
exists, and everything downstream depends on it being right.

- [ ] 2.1 Extend the money helpers: percentage of a base and `fraction`
      (numerator/denominator) over `bigint` cents, both rounding down. One
      multiply then one divide — exact until the final truncation.
- [ ] 2.2 The four amount forms as a discriminated union: `fixed`, `percent` with
      a mandatory base, `fraction`, `remainder`. Reject a `percent` with no base
      at write time.
- [ ] 2.3 Property test: for any generated step sequence and any trigger amount,
      the resolved amounts plus the tail equal the trigger amount **exactly**.
      This is the conservation property (A5), and it is the test that makes
      over-allocation structurally impossible rather than merely unlikely.
- [ ] 2.4 Property test: no resolved amount ever exceeds the remainder available
      to it.
- [ ] 2.5 Worked-example tests from the design: `3/23` of `1150.00` is exactly
      `150.00`; `1000.00` through GST, 33% of remaining and a fixed `200.00`
      gives `130.43`, `286.95`, `200.00` and a tail of `382.62`.

## 3. The evaluator becomes a scan

- [ ] 3.1 Replace the flat effect list with an ordered step list in
      `rules.types.ts`. `add-rule-triggers` has not shipped, so no stored rule
      needs migrating — this is the last moment that is true.
- [ ] 3.2 Rewrite the fold as a left scan carrying `allocated` and `remaining`.
      The trigger `amount` is read-only; assert that in a test, because
      overwriting it is the obvious shortcut and it silently breaks rule matching.
- [ ] 3.3 Skip-on-insufficient (A6): record the step, the amount it needed and
      the amount available. Never shrink a step to fit — a test should assert a
      `200.00` step against `150.00` remaining moves nothing at all.
- [ ] 3.4 Exclusive allocation (A3): the first matching rule with transfer steps
      allocates; later ones have their transfer steps skipped and recorded.
      `notify` and `ignore` continue to fold across every matching rule.
- [ ] 3.5 Report the unallocated tail as part of the result, not as something a
      caller derives.
- [ ] 3.6 Update `test/rules.engine.test.ts` throughout, keeping the priority and
      `stopProcessing` coverage that already exists.

## 4. The canvas's server half

- [ ] 4.1 Reshape `POST /api/rules/evaluate` to take a **draft** rule body plus a
      preview amount, and return per-step resolved amounts, the running remainder,
      skips with reasons, and the tail.
- [ ] 4.2 Default the preview amount from the draft's own `amount gte`/`gt`
      condition; otherwise require one. Assert in a test that no stored
      transaction is read — there are none, and the obvious "use their last
      payment" implementation is the one the privacy posture forbids.
- [ ] 4.3 Property test: `preview(amount)` and the proposal generated from a real
      transaction of that amount are identical. This is the guard against a
      second implementation appearing.
- [ ] 4.4 Refuse a draft referencing an account the caller does not own, under the
      caller's own client, exactly as rule creation does.
- [ ] 4.5 Warn when another enabled rule with transfer steps could match the same
      transaction, naming which one takes precedence (A3's cost, made visible).

## 5. The proposal carries the waterfall

- [ ] 5.1 Store per-step resolved amount, destination, remaining-after, and status
      in `pending_executions.effects`. No new table.
- [ ] 5.2 Store skipped steps with their reasons, and the pre-empted rule where
      one exists, so the approval screen shows what the canvas showed.
- [ ] 5.3 Store the unallocated tail.
- [ ] 5.4 Test: a three-step proposal renders in order, with the tail, and the
      approval executes exactly the stored amounts.
- [ ] 5.5 Test: partial failure reports per step in position; the execution is not
      reported as wholly successful.

## 6. The loop guard

- [ ] 6.1 Record the payment reference (`sid`, from `add-rule-triggers` E7)
      against the execution's step so a returning transaction can be matched to it.
- [ ] 6.2 Ingestion skips transactions it initiated. Test that a settled internal
      transfer returning as a credit webhook produces no proposal **with no
      user-authored `ignore` rule present** — the guard must not depend on one.
- [ ] 6.3 Test that a genuinely manual internal transfer is still evaluated
      normally.

## 7. Consent bounds over sequences

- [ ] 7.1 Compute the largest single step amount and the sequence total from the
      step list, and check them against the single-payment and periodic limits.
- [ ] 7.2 Bound percentage-of-remainder steps by the trigger amount, and word the
      warning so it does not claim certainty it does not have.
- [ ] 7.3 Test: a four-step rule warns on the periodic limit even where no single
      step breaches the single-payment limit.

## 8. Documentation

- [ ] 8.1 `CLAUDE.md`: the engine is a left scan with registers, not a fold; steps
      are ordered by array position and nothing else.
- [ ] 8.2 `CLAUDE.md`: the preview endpoint is the canvas's source of truth and
      the allocation arithmetic must not be mirrored client-side — a divergence
      shows the user one number and moves another.
