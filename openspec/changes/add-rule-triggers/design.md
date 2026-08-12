## Context

`add-onboarding` delivers a subscribed user with one or more Akahu connections, a
read-only account projection, and a registered APNs token. This change makes the
product work.

The shape, settled during exploration:

```
  Akahu ──webhook──▶ verify signature ──▶ akahu_user_id → user_id
                                                │
                                     evaluate rules (pure, unchanged)
                                                │
                                     INSERT pending_execution
                                                │
                                          thin APNs push
                                                │
  user reviews in app ──▶ POST approve       ← user JWT, RLS, no signature
                                                │
                                     CAS pending → executing
                                                │
                                        POST /payments
                                                │
                          payment webhook ──▶ SENT / DECLINED / ERROR
```

Four facts from the Akahu documentation drive the design:

- **`POST /payments` documents no idempotency mechanism.** There is no
  idempotency key to lean on. Duplicate suppression is entirely ours.
- **Payments are asynchronous.** `READY`, `PENDING_APPROVAL`, `PAUSED` precede
  the final `SENT`, `DECLINED`, `ERROR`, `CANCELLED`. A 200 from `POST /payments`
  means accepted, not settled.
- **Webhooks are subscribed per user**, signed RSA-SHA256 with the key id in
  `X-Akahu-Signing-Key` and the signature in `X-Akahu-Signature`. Akahu retries
  for about a day, then may disable the endpoint.
- **A payment's destination must already appear in the payer account's
  `payment_consents`**, and the payer account must carry the `PAYMENT_FROM`
  attribute. Both are readable from `GET /accounts`.

That last one is unexpectedly helpful: whether a rule needs a new consent
redirect is answerable from a read, without guessing.

## Goals / Non-Goals

**Goals:**

- A transaction arriving at a connected account produces at most one proposal,
  exactly once, even under webhook redelivery and reconciliation overlap.
- Money moves only after the owner explicitly approves a specific, already-resolved
  amount, and never automatically.
- No transaction data is persisted: not amount, not merchant, not description.
- Rule authors can express "money received", and a rule that cannot yet fire says
  so rather than silently doing nothing.

**Non-Goals:**

- Categorisation, tagging, spending history, budgets. The removed actions are not
  coming back in another form.
- Debit-triggered rules as a first-class product surface. `direction` supports
  them; nothing in the UI is designed for them.
- Paying third parties. Destinations are the user's own connected accounts.
- Learning from declines (the "you've declined this five times" signal). Recorded
  as a v2 idea during exploration; the retained rows make it possible later.

## Decisions

### E1. Effects replace annotations; `ignore` is redefined

```
  removed   set_category, add_tags, set_note, set_account
  added     notify   { }                      → push only, no approval
            transfer { to, amount }           → proposal requiring approval
  kept      ignore   { }                      → produce no proposal at all
```

`set_account` goes because with a bank feed the account is a fact, not an
opinion; there is nothing to reassign. `ignore` earns its place: a priority-0
rule matching internal transfers between the user's own accounts, with
`stopProcessing`, suppresses everything downstream. That is a real need and the
existing priority machinery already implements it.

*Alternative considered:* keeping a generic `set_metadata` effect for future use.
Rejected — a jsonb column with no reader is a liability, and this change is
already the one that gets to break the schema for free.

### E2. `direction` is a first-class condition field

Added to `ruleFieldSchema` as `credit | debit`. Rules do not infer direction from
the sign of `amount`.

Sign conventions differ between aggregators and between account types (a credit
card credit is a payment *to* the card). Encoding that reasoning into
user-authored rules would bake an Akahu implementation detail into stored data
that outlives the integration.

### E3. Money is integer cents in `bigint`, and percentages round down

Decimal strings at the boundary, `bigint` cents internally, never a `number`.
`transactionCandidateSchema.amount` changes from `z.number()` to the same
decimal-string schema `accounts` already uses. `compareNumeric` is deleted.

A percentage **names its base**: `{ percent: 7.5, of: 'original' }`, not a bare
`7.5`. Today there is only one thing a percentage could be of, so the field looks
redundant. It is not — `add-rule-allocation` introduces percentages of a running
remainder, and 33% of a post-GST amount is 28.7% of the original. A stored rule
whose base is implied is a rule whose meaning can be reinterpreted later, and
retrofitting the field once rules exist is a jsonb migration over live data. One
field now, for the same reason `direction` is stored rather than inferred (E2).

Percentage transfers **round down to the cent, always**. Not banker's rounding,
not round-half-up: the user approved a number and the system must never move more
than that number. The rounding rule is a documented, tested property, not an
artefact of whichever helper was reached for.

*Alternative considered:* floats are, in practice, exact enough for comparison at
these magnitudes. Rejected — the same values flow into percentage arithmetic that
determines a debit, the boundary cases are exactly where rules are written
("more than $1000"), and the codebase already declares money is never a float.

### E4. One transaction produces one proposal with many effects

The engine already folds matching rules' actions in priority order and honours
`stopProcessing`. That folding is retained: three matching rules yield one
proposal carrying three effects, one push, and one approval — not three of each.

Consequently the effect list carries **per-effect status**, because two transfers
can succeed while a third is declined for insufficient funds.

### E5. The webhook path may propose; it may never cause an external effect

The inbound webhook has no user JWT. It resolves the user by reverse lookup and
runs as service role, which is one guard where the rest of the codebase has two.
The compensating rule is absolute:

> Code reachable from the webhook handler may write `pending_executions` and send
> a notification. It may not call `POST /payments`, and it may not act on a user
> id taken from a request body — only on one resolved from the token table.

Every payment therefore originates from an authenticated, RLS-checked,
signature-verified request. The worst a forged webhook achieves is an unwanted
notification.

### E6. Compare-and-swap is the only concurrency primitive available

There is no Postgres connection and therefore no `BEGIN`. Given `POST /payments`
has no idempotency key, this is the entire duplicate-payment defence:

```ts
.from('pending_executions')
.update({ status: 'executing', approved_at: now })
.eq('id', id).eq('user_id', userId).eq('status', 'pending')
.select()
```

Zero rows returned means another request won; return the current state and do not
pay. This looks like an ordinary filter chain and is not, so it carries a comment
saying so and a test that hammers it concurrently.

### E7. Transition to `executing` before calling Akahu, never after

If the process dies between the state write and the payment call, the row reads
`executing` and needs reconciliation — recoverable, and detectable by the sweep
via the `sid` reference Akahu puts in the payer's particulars. The other ordering
loses the row and pays twice on retry. Failure toward the recoverable side is the
only acceptable direction when the failure mode is someone's money.

### E8. The computed amount is stored at proposal time, not recomputed at approval

The proposal records `transfer $100.00 to acc_x`, not "10% of trans_abc".

Recomputing at approval would store less, but it puts Akahu in the approval path
— they are down, the user cannot approve — and lets the amount drift between what
the push showed and what executes. Storing the resolved instruction keeps the
principle intact: **we store our own instructions, never Akahu's facts.** An
approval is then an exact contract over a specific number — the one the user was
shown is the one that executes, because the client never restates it (E11).

The trigger amount is deliberately *not* stored. The activity feed reads "Payday
rule → moved $100 to Savings"; the rule name carries the meaning.

### E9. Propose on settled transactions only

Pending transactions can change amount or vanish. Firing a transfer against a
credit that later reverses moves money that never arrived. Only settled
transactions produce proposals.

If latency proves unacceptable, the fallback is to notify on pending and re-check
settlement at approval — the approval gap is a natural place for it. Not built
now; noted so the option is not designed out.

### E10. Pushes are thin, and are never the only route

The APNs payload carries the execution id and a generic title
("A rule is ready to run"). Amounts and account names are fetched by the app over
TLS.

An amount on a lock screen is someone's salary shown to whoever is nearby, and it
would route their financial data through Apple's servers for no benefit. A
Notification Service Extension can enrich the notification after fetching, so the
user still sees detail — on their own unlocked device.

Because a failed push otherwise means a rule silently never runs, the durable
surface is an in-app pending list with a badge count. Push is an accelerator, not
the mechanism.

### E11. Approval is an authenticated tap; the consent limits are the real control

```
  POST /api/executions/:id/approve    ← user JWT, RLS, nothing else
  POST /api/executions/:id/decline    ← same
```

There is no challenge, no nonce, and no signature. The stored effects execute; a
client cannot restate the amounts.

*This reverses an earlier decision and the earlier reasoning was not wrong, so it
is kept here rather than deleted.* The rejected design had the app sign a
canonical encoding of the execution id, a server nonce, and a digest of the
effects with a Secure Enclave key enrolled at onboarding. Its argument: Face ID
that merely unlocks a Keychain-held refresh token is a *client-side* gate — the
server receives the same bearer token whether a face was presented or not — so
only a signature makes "a stolen session cannot move money" true.

What that argument omits is the ceiling. Akahu's enduring payment consent carries
a **single-payment limit and a periodic limit enforced by the bank**, and payees
are fixed by rules the user already wrote. An attacker holding a session cannot
invent a destination without first editing a rule, and cannot exceed limits the
user set at consent time. The worst case is therefore bounded by a number the
user chose, not unbounded. Against that, per-payment biometrics cost an enclave
enrolment step during onboarding that has to be justified before any rule exists,
a challenge endpoint, a canonical byte encoding shared across two repositories,
published test vectors, a CI drift check, and a re-enrolment path for keys
invalidated by `.biometryCurrentSet`.

**Revisit if the product moves larger sums.** This trade holds while consent
limits are modest. It does not hold for a product encouraging five-figure
limits, and the signature design above is the thing to reach for — it is
recorded in enough detail to rebuild.

*Alternative considered:* trusting a client-asserted `biometricVerified: true`
flag. Rejected as unverifiable, which makes it worse than nothing — it looks like
a control in code review while providing none. Requiring authentication and being
honest about it is better than a decorative check.

**Consequence for duplicate suppression.** The single-use nonce was one of four
layers preventing a double payment. Without it, E6's compare-and-swap carries
that weight alone on the approval path, which raises the stakes on its
concurrency test.

### E12. Payment consent is requested at first money-moving rule

A consent is bound to one payer account and can only pay payees named in the
request, which cannot be known before accounts are discovered. Deferring puts the
bank's "allow this app to move up to $500/month" screen next to a concrete rule
the user just wrote, rather than in the middle of signup.

Consent labels are keyed on the payer account (`payer:<akahu_account_id>`), and
re-consenting with the same label replaces it. Each request nominates the union
of destinations the user has asked for from that payer so far, so:

```
  first rule from an account          → redirect
  new destination, same payer         → redirect (payee set grew)
  same payer, same destination        → no redirect   ← the common case
```

Whether a redirect is needed is determined by reading `payment_consents` on the
account from `GET /accounts`, not by trusting local state.

A rule whose consent is not yet in place is stored with status `pending_consent`
and does not fire. Silence is not an acceptable representation of "not
authorised".

### E13. Account numbers and verification tokens are fetched, never stored

`POST /payments` needs the destination's `account_number` and holder `name`.
Both are fetched from Akahu at payment time. Verification tokens, likewise, are
generated on demand — this inherits `add-onboarding` D11, and the reasoning is
the same: a stored token is a persisted assertion about a real person's name and
bank account number.

This is the one place the design accepts an Akahu dependency in the payment path.
It is acceptable because the alternative is holding account numbers at rest, and
because a payment cannot succeed while Akahu is unreachable anyway.

### E14. Revocation and disconnection invalidate in-flight proposals

When a consent is revoked, a connection removed, or a `TOKEN`/`DELETE` webhook
received, every `pending` execution for the affected account moves to
`invalidated`. Rules referencing a disconnected account move to
`pending_consent` and are surfaced as broken in the app.

An approvable proposal against a revoked consent produces a payment that fails at
the bank with `CONSENT_REVOKED` — a confusing failure after the user did
everything right.

### E15. The pending execution is one table doing four jobs

Idempotency ledger, audit log, approval queue, and the app's primary read model.
Unique on `(user_id, akahu_txn_id)`: the existence of a row *is* the duplicate
check, so there is no second table to keep consistent.

```
  pending_executions
    id, user_id, rule_ids[], akahu_txn_id (unique with user_id),
    trigger_account_id, effects jsonb (per-effect status + akahu payment id),
    status, created_at, expires_at, resolved_at
```

Rows are retained after resolution. They are the audit trail for money movement
and must outlive the proposal.

### E16. Two scheduled sweeps

Expiry (proposals older than their TTL move to `expired`) and reconciliation
(transactions since the last cursor with no corresponding row). Both run as
Render cron.

Reconciliation is not optional: Akahu retries for about a day and may then
disable the endpoint entirely. Without a sweep, a bad deploy window means rules
that silently never fired.

Proposal TTL defaults to 48 hours, system-wide, not per rule. "Move 10% of your
salary" is meaningful for a day; by the following week the money is spent and the
payment fails on insufficient funds.

### E17. The approval endpoint does not check for an originating webhook; the table's write surface is the control

A natural instinct is to have `POST /approve` verify that a genuine Akahu webhook
preceded the execution, so that a malicious call with no originating event is
refused. That check is deliberately absent, for two reasons.

**It would be re-deriving a fact from the row that proves it.** Approval names an
id and nothing else — the body is ignored (E8, E11). There is no instruction to
forge, and a guessed id is a 404 under RLS. The existence of a `pending_executions`
row already *is* the evidence that ingestion ran.

**A webhook is not the only legitimate origin.** E16's reconciliation sweep exists
precisely because Akahu retries for about a day and may then disable the endpoint.

```
  webhook ──┐
            ├──▶ INSERT pending_executions ──▶ approvable
  sweep ────┘
      ▲
      └─ both are server-side ingestion; neither is client-reachable
```

A requirement phrased as "there must have been a webhook" would make every
sweep-recovered execution un-approvable — turning a delivery failure into a rule
that fired, notified, and then could not be acted on. That is the exact failure
the sweep was built to prevent.

So the invariant worth enforcing is not *a webhook arrived*, it is **only
server-side ingestion may write `pending_executions`** — and that belongs in the
table's grants, not in a handler:

```
  pending_executions RLS
  ──────────────────────
  select   owner            ✓   the in-app pending list (5.4)
  insert   —                ✗   ingestion only, service role
  update   —                ✗   the CAS transition only, service role
  delete   —                ✗   retained forever (E15)
```

**This is where the real exposure was.** The house pattern — `accounts` and
`rules` in `00000000000001_init.sql` — grants the owner full CRUD, and "owner RLS
policies" in the task list would have produced exactly that. An insertable
`pending_executions` lets anyone holding a session post a row with an invented
`akahu_txn_id` and an effect of their choosing, then approve it: the rule engine,
`ignore`, `stopProcessing` and the requirement that a transaction actually
occurred are all bypassed. The consent limits still cap the amount and the payee
set (E12), so this is not unbounded — but it also forges the audit trail and can
pre-empt a real transaction's idempotency key (E15). An updatable row is the same
hole by a slower route: rewrite `effects`, then approve.

`public.profiles` already carries the corrective pattern and the comment
explaining it. `pending_executions` is the first table where RLS is a *read-only
window onto server-written rows* rather than the owner's write gate, which reads
as a mistake to anyone applying the house pattern — hence a comment in the
migration and tests that assert the refusals.

**Provenance is recorded** (`source`: `webhook` | `reconciliation`). It costs a
column and makes two things possible: proving in the audit trail how a payment
came to be proposed, and noticing a silently dead webhook endpoint as a shift in
the mix. It is the useful, after-the-fact form of "did a webhook trigger this?" —
and, notably, not a gate.

## Risks / Trade-offs

**Duplicate payment.** No idempotency key at Akahu; webhook redelivery, double
taps, and crash-retry all attack it. → E6 CAS, E7 ordering, unique
`(user_id, akahu_txn_id)`. Three layers, not the original four — E11 removed the
single-use nonce, so CAS is now the only thing standing between a double tap and
two payments. The concurrency test that runs approve twice in parallel and
asserts exactly one payment is correspondingly load-bearing.

**Regex denial of service.** The `matches` operator compiles a user-supplied
pattern, and this change makes it run automatically on every inbound transaction
on a single-threaded event loop. A catastrophic backtracking pattern stalls the
whole service, not just that user. → Cap pattern length, reject nested
quantifiers at write time, and evaluate under a time budget. This was tolerable
when `matches` only ran in a dry-run endpoint; it is not now.

**A rule that exceeds its consent limit.** A rule transferring $1000 against a
consent with a $500 single limit fails at the bank with
`SINGLE_LIMIT_EXCEEDED`, after the user approved it. → Validate the maximum
possible transfer against the consent's limits at rule-creation time and warn.
Percentage rules have no bound, so warn rather than block.

**Payments settle asynchronously.** A `SENT` status can still be followed by
problems, and `PENDING_APPROVAL` may need bank-side action. → Track the Akahu
payment id per effect and settle from payment webhook events; never report
success to the user from the `POST /payments` response alone.

**Push failure means a silent no-op.** → E10's in-app pending list plus a badge;
never rely on delivery.

**A compromised session can move money.** Approval requires authentication only
(E11), so anyone holding a valid access token — a stolen device already unlocked,
an exfiltrated refresh token — can approve a pending execution. → Accepted, with
the ceiling set by Akahu's bank-enforced single-payment and periodic limits and
by payees being fixed in advance by the user's own rules. Depends on those limits
staying modest; revisit alongside E11 if they do not. The mitigations available
without reintroducing signatures are shorter session lifetimes and a push on every
approval, so an unexpected one is at least visible.

**This service now moves money on people's behalf.** → Akahu holds the payment
rails and the bank relationship, but confirm what obligations fall to this
application before launch, not after.

## Migration Plan

Append-only migrations from here; the in-place edit allowed in `add-onboarding`
is not repeated.

1. Rules schema and types first, with the engine rewritten and unit tested. It is
   pure, so it can be finished and proven before any integration exists.
2. `pending_executions` and the CAS repository, with the concurrency test. The
   duplicate-payment defence is proven before anything can pay.
3. Webhook ingestion: signature verification, reverse lookup, dedup. Proposals
   are created and notifications sent. Still no payments — the system is
   observable end to end while remaining incapable of moving money.
4. Consent flow and the `pending_consent` rule state.
5. Approval: the CAS transition, then payment initiation. Deliberately last.
6. Payment settlement webhooks, then the two sweeps.
7. Webhook subscription added to token exchange, plus a backfill for users
   onboarded before this change shipped.
8. `CLAUDE.md`: the webhook invariant (E5), CAS as the concurrency primitive
   (E6), the background worker, the new modules.

Step 3 is a genuine milestone worth pausing on: everything is real except the
money.

## Open Questions

1. **Does `INITIAL_UPDATE` need suppressing?** Connecting a bank replays historic
   transactions. Without a guard, a new user's first connection could generate
   months of proposals at once. Almost certainly the answer is to ignore
   `INITIAL_UPDATE` entirely and act only on `DEFAULT_UPDATE` — but it needs
   confirming, and getting it wrong is spectacular.
2. **What is the reconciliation cursor?** Akahu transaction ids are opaque; a
   timestamp cursor risks gaps at boundaries. Needs a read of the transactions
   API pagination contract.
3. **Should a `transfer` rule be blocked or warned when a percentage could exceed
   the consent's single limit?** Blocking is safer and may be infuriating.
4. **Per-rule proposal TTL?** Defaulted to 48h system-wide (E16). Revisit only if
   users ask.
5. **`PAYMENT_FROM` versus BECS eligibility** — `add-onboarding` stores one
   `payment_eligible` flag; two are needed. Amended in that change's spec, but the
   projection sync work lands here.
