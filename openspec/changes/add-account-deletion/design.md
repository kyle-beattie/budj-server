## Context

By the time this change is implemented, a user has: a Supabase identity, an
encrypted Apple grant, an App Store subscription, an encrypted Akahu
token, one or more Akahu connections with per-user webhook subscriptions, payment
consents bound to individual payer accounts, an account projection, rules,
registered devices, and a history of executions.

Deleting them means unwinding four external systems in a fixed order, with no
transaction available anywhere, and no way to roll back a call that succeeded.

The inventory of personal data is small, and deliberately so. Nothing here holds
a transaction, a balance, an account number, a merchant, or a description. The
hard part of deletion is not finding the data — it is sequencing the teardown so
that the credential needed to perform it survives long enough to be used.

## Goals / Non-Goals

**Goals:**

- A user can delete their account entirely from within the app, and every
  external connection is genuinely revoked.
- The order of operations is a tested property, because getting it wrong fails
  silently and irreversibly.
- Deletion is immediate from the user's perspective and eventually consistent
  across providers, surviving crashes and provider outages.
- Nothing personal remains afterwards.

**Non-Goals:**

- A grace period or undo. Decided against: recovery would require reconnecting
  the bank regardless, so the window buys the user very little and keeps a live
  credential alive for no good reason.
- Data export before deletion. Worth doing and worth its own change; bundling it
  here delays something App Review gates on.
- Retaining a financial audit trail. Decided against — see X5.
- Deleting the user's data at Akahu. Not possible; they are a separate data
  controller.

## Decisions

### X1. External teardown first, `auth.users` last

The whole design in one diagram:

```
  needs local rows, so runs BEFORE the cascade
  ──────────────────────────────────────────────────────────
   1  cancel cancellable payments   akahu token + payment ids
   2  revoke payment consents       akahu token + consent ids
   3  unsubscribe webhooks          akahu token + webhook ids
   4  revoke the Akahu token        akahu token   ← last Akahu call
   5  end local entitlement         (the store subscription cannot be
                                      cancelled from here — see X11)
   6  revoke the Apple grant        apple refresh token
   7  global sign-out               admin client
  ──────────────────────────────────────────────────────────
   8  delete auth.users → cascade removes everything else
```

Step 4 must follow 1–3 because revoking the token first makes them impossible.
Step 8 must follow everything because it destroys the inputs to all of them.

*Alternative considered:* copying the identifiers into the deletion record first,
then deleting the user, then tearing down from the copy. Rejected — it duplicates
credentials into a second table purely to enable an ordering that has no benefit,
and it widens the window in which an Akahu token exists in two places.

### X2. Deletion is a job; the request only records intent

The endpoint writes `account_deletions` and returns. A cron worker performs the
teardown with exponential backoff.

Seven external calls in a request handler means an eight-second wait, a timeout
on the fourth call, and an account that is half dismantled with no record of how
far it got. Apple accepts asynchronous completion provided the deletion is
*initiated* in-app, which it is.

Every step is idempotent and independently marked complete, so a retry resumes
rather than restarts. "Already revoked" — a 404 from a revoke, entitlement
already ended — counts as success, because the desired state has been reached.

### X3. The deletion record must not cascade

`account_deletions` holds the user id as a plain `uuid` with **no foreign key** to
`auth.users`.

If it cascaded, step 9 would delete the row tracking step 9. A crash in that
window would leave no evidence a deletion was ever requested, and no way to
distinguish a completed deletion from one that never began. The row outlives the
user by construction.

### X4. Confirmation is the session, plus an unambiguous screen

Deletion requires authentication and nothing more.

This follows the principle the earlier draft used — *an account that can move
money deserves at least the protection moving money gets* — through the decision
in `add-rule-triggers` E11 that moving money needs a session only. The original
plan was an ES256 signature over a server challenge, reusing the payment approval
path; that path no longer exists, so "the mechanism already exists, so this is
nearly free" is false and the justification collapses with it.

A password re-prompt is not the fallback: users who signed in with Apple or
Google have no password, which makes it awkward as well as weaker than what it
replaces.

**Open question.** Deletion is immediate and irreversible (X3), which is a
sharper edge than a bounded payment — an unlocked phone in the wrong hands costs
the whole account rather than a capped transfer. If that asymmetry matters,
Supabase reauthentication (a fresh provider token exchange or a one-time code to
the address in the JWT) is the option that works for provider and password users
alike. Not built here; decide before this change is implemented.

### X5. Everything personal is deleted, including the execution history

No retention. Rules, executions, connections, consents, devices, profile — all
cascade away.

The counter-argument is that "user X instructed a $100 payment on date Y" is a
financial record worth keeping. It is rejected on the grounds that this
application is not the system of record for that payment: Akahu holds it, and so
does the bank. The payment does not become unauditable, only unauditable *here*.
Retaining a shadow copy of someone's payment history after they have asked to be
forgotten, in order to answer a question two other parties can already answer, is
not a trade worth making.

*Alternative considered:* de-identified retention — amounts and timestamps with
identifiers stripped. Rejected as a false comfort: a payment of an unusual amount
at a known timestamp is re-identifiable against Akahu's records, so it would be
retention wearing a disguise.

### X6. One exception, and it is not personal data

A payment already sent to Akahu that cannot be cancelled will settle after the
user is gone. For those, and only those, a stub survives:

```
  orphaned_payments
    akahu_payment_id, amount, currency, created_at, settled_at, outcome
    ── no user id, no account id, no transaction id, no rule, no name
```

Without it, the settlement webhook arrives, the reverse lookup finds nothing, and
the event is discarded — the single case where money moved and nothing in the
system can tell you. The stub is purged once the payment reaches a terminal
state, so it is transient rather than a retention policy under another name.

An Akahu payment identifier and an amount are not personal data on their own,
which is what keeps X5 intact.

### X7. In-flight payments are cancelled where possible and never waited on

```
  effect state         action
  ─────────────────────────────────────────────────────────
  pending              invalidate the proposal
  executing            attempt PUT /payments/{id}/cancel
  PENDING_APPROVAL     attempt cancel; on failure, stub (X6)
  PAUSED               attempt cancel; on failure, stub (X6)
  SENT / DECLINED      terminal, nothing to do
```

Deletion never blocks on a payment settling. A payment stuck awaiting bank action
for a week cannot hold a privacy request open for a week, and the user has
already been told their account is gone.

### X8. Deletion state is enforced on the request path

`auth.plugin.ts` verifies JWTs locally against JWKS with no revocation check —
that is the fast path and it should stay. But it means `signOut` does not
invalidate an access token already issued, so a cached token authenticates until
it expires.

During teardown that token could approve a payment on an account being deleted.
The check folds into the existing `requireSubscription` hook, which already
performs a lookup, rather than adding a second hook and a second query.

This is worth stating plainly because the natural assumption — "we called
`signOut`, they are locked out" — is false here, and the failure is invisible.

### X11. Deleting the account does not stop the charging, and the user must be told first

Apple provides no way to cancel a subscription on a user's behalf. There is no
endpoint. Only the user can, in App Store settings.

So the honest sequence is a warning *before* deletion, not a step during it:

```
   user taps Delete Account
            │
            ▼
   ┌────────────────────────────────────────────────┐
   │  You have an active subscription.              │
   │  Deleting your account will NOT cancel it —    │
   │  Apple will keep charging you.                 │
   │                                                │
   │  [ Manage Subscription ]   ← deep link to      │
   │  [ Delete anyway ]           App Store settings│
   └────────────────────────────────────────────────┘
```

The warning is shown only when entitlement is currently active, and deletion is
never blocked on it — a user who insists proceeds. Blocking would make the
privacy request contingent on an action in someone else's app.

Teardown's billing step therefore ends *local* entitlement and records that the
store subscription was left live. Nothing else is possible, and pretending
otherwise in code would be worse than admitting it in the UI.

This is a direct consequence of `add-onboarding` D8: it is the price of IAP, and
it did not exist under Stripe, where cancellation was one API call.

### X9. Revocation is one routine, shared with subscription lapse

`add-onboarding` D9 already revokes the Akahu token and disconnects connections
when a subscription ends. Steps 2–4 of X1 are the same work.

One `revokeExternalAccess(userId)` serves both. Two implementations of "cut off
this user's bank access" would drift, and the one exercised less often would be
the broken one.

### X10. Cascade coverage is asserted, not assumed

A test enumerates the tables in `public` and asserts each either cascades from
`auth.users` or is deliberately listed as exempt (`account_deletions`,
`orphaned_payments`).

Three changes have each added tables. The fourth will too. A new table that
quietly fails to cascade is a data-retention bug that no code review reliably
catches and no user ever reports.

## Risks / Trade-offs

**A partial teardown leaves a live bank consent.** The worst outcome available:
the user is told they are gone, and an enduring payment consent remains against
their bank account. → Strict ordering (X1), per-step completion marks, unbounded
retries with backoff, and alerting when a deletion has not completed within a
day. This must page someone; it is not a log line.

**Provider outage stalls deletions indefinitely.** → Retries continue and the job
is resumable. A deletion older than 24 hours is surfaced operationally rather
than silently retried forever.

**Apple's grant may be missing.** Any user who signed up before `add-onboarding`
task 4.7 shipped, or whose code exchange failed, has no stored refresh token and
cannot be revoked with Apple. → Recorded on the deletion record as unrevoked
rather than treated as success, so the gap is countable instead of invisible.

**A deleted user keeps being charged.** The most likely support and review
complaint this feature will generate, and it is unavoidable — see X11. →
Prominent pre-deletion warning with a deep link to App Store subscription
management, and copy in the privacy notice. Apple's own account-deletion guidance
expects apps to inform users of active subscriptions, so this is also a review
expectation and not only good manners.

**Re-signup after deletion.** The same person signing in again with Apple gets a
new Supabase user and a clean account. Deliberate — there is no free tier to
abuse, so nothing needs preventing.

**A cached access token acts during teardown.** → X8.

## Migration Plan

1. Cascade coverage test first (X10), against the schema as it stands. Expect it
   to find something.
2. `account_deletions` and `orphaned_payments`, both without a foreign key to
   `auth.users`.
3. `revokeExternalAccess(userId)` extracted from the D9 lapse handler and made
   idempotent, with the lapse path switched over to it. No behaviour change yet —
   verifiable on its own.
4. The teardown worker, each step separately testable against provider sandboxes,
   with a test that asserts the ordering rather than merely the outcome.
5. The deletion endpoint and its signature verification, reusing the approval
   challenge path.
6. X8's deletion-state check in `requireSubscription`.
7. Privacy notice and deletion-screen copy: what is deleted, what Akahu and Apple
   retain, that an active subscription keeps charging until cancelled in App Store
   settings, and that deletion cannot be undone.

Rollback is removing the endpoint. In-flight deletions must still be allowed to
complete — a half-torn-down account is worse than either end state.

## Open Questions

1. **How long should `orphaned_payments` survive if a payment never reaches a
   terminal state?** A payment abandoned at `PENDING_APPROVAL` forever would
   otherwise keep its stub forever, which is a retention policy created by
   accident.
2. **Should deletion be refused while a payment is `executing`?** X7 says no, and
   proceeds. The alternative — a short bounded wait, perhaps an hour — trades a
   little immediacy for a lot fewer stubs. Worth revisiting once real payment
   timings are known.
3. **What happens if a refund notification arrives for a deleted user?** The
   subscription outlives the account (X11), so App Store notifications will keep
   coming for someone who no longer exists. They cannot be matched to a user and
   currently have nowhere to go.
4. **Should the app offer data export alongside deletion?** Explicitly a
   non-goal here, but it is the natural moment to ask for it, and the payload
   would be small.
