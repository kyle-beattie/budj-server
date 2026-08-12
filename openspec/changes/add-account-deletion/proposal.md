## Why

App Store Guideline 5.1.1(v) requires any app supporting account creation to
support account deletion **in the app**. "Email us and we'll remove it" fails
review. This is not a feature that can wait for a second release — it gates the
first submission.

Beyond the obligation, deletion is where an application's data handling is
actually tested. This one should do well: it never stored a transaction, a
balance, an account number, or a merchant name, so there is no shadow copy of
anyone's financial life to hunt down. Almost everything falls to a single
cascade.

Almost. The one thing that must not be deleted first is the credential required
to dismantle everything else. Every table hangs off `auth.users` with
`on delete cascade`, so the obvious implementation —
`auth.admin.deleteUser(userId)` — destroys the Akahu token and the Apple grant in
the same instant it removes the user, leaving an enduring payment consent live
against a real person's bank account with no identifiers left to revoke it. Akahu
keeps billing you. There is no way back.

## What Changes

- **An in-app deletion endpoint**, requiring authentication only — the same
  control that authorises moving money authorises destroying the account. Whether
  an irreversible deletion warrants more than a bounded payment does is X4's open
  question, and is settled before the endpoint is built.
- **Deletion is a retried background job, not a request.** Seven external calls
  across three providers, none of which can be rolled back, each made idempotent
  so "already revoked" counts as success.
- **A strict teardown order**, external first and `auth.users` last, because the
  local rows are the inputs to the external calls.
- **Immediate and irreversible.** No grace period and no undo: the session is
  revoked and the account is unusable the moment deletion is requested.
- **Everything personal is deleted.** No retention of rules, executions,
  connections, or history. The single exception is a de-identified stub for a
  payment already in flight — an Akahu payment identifier and an amount, no user,
  no account, no transaction — purged once that payment reaches a terminal state.
- **A deletion record that does not cascade.** Held in a table with no foreign
  key to `auth.users`, or the final step would erase the evidence it ran.
- **The access-token window is closed.** `requireAuth` verifies JWTs locally
  against JWKS with no revocation check, so an already-issued token stays valid
  for up to its full lifetime after deletion is requested. Without a check, a
  cached token could approve a payment on an account being deleted.

## Capabilities

### New Capabilities

- `account-deletion`: The deletion request and its biometric confirmation, the
  teardown state machine, per-provider revocation with idempotency, ordering
  guarantees, the non-cascading deletion record, and what happens to payments
  still in flight.

### Modified Capabilities

- `billing`: The subscription gate becomes the enforcement point for deletion
  state too, since it already performs a lookup and a valid access token outlives
  the session it came from. Teardown shares one revocation routine with the
  entitlement-lapse handling in `add-onboarding` D9 rather than diverging from
  it — and must warn, before deletion, that an App Store subscription keeps
  charging because no API can cancel it.

## Impact

**This is the highest-consequence ordering problem in the codebase.** Getting the
sequence wrong does not throw an error — it silently leaves a live bank consent
belonging to someone who believes they have left. The ordering is a tested
property, not a comment.

**Depends on both prior changes.** It cannot start until `add-onboarding` has
stored the Apple grant and `add-rule-triggers` has built the payment lifecycle
and the cron worker. It reuses the challenge/signature path, the encryption
helper, the service-role accessor pattern, and the cron entry point — no new
architectural machinery.

**Database.** One `account_deletions` table, deliberately without a foreign key
to `auth.users`. One `orphaned_payments` stub table, same isolation. Verification
that every table added by the two prior changes actually cascades.

**Modules.** One new `account` module. Additions to `billing` for the shared
revocation routine.

**External APIs.** Akahu `PUT /payments/{id}/cancel`,
`DELETE /accounts/{id}/payment-consents/{id}`, `DELETE /webhooks/{id}`,
`DELETE /token`; Apple `POST /auth/revoke` for the Sign in with Apple grant;
Supabase `auth.admin.signOut` and `auth.admin.deleteUser`. Notably absent:
anything that cancels the subscription, because no such API exists.

**What cannot be deleted or stopped, and must be disclosed.** Revoking the Akahu
token removes this application's access; it does not delete the user's data at
Akahu, who remain a separate data controller. Apple retains purchase records.
And an active App Store subscription **keeps charging after the account is
gone** — only the user can cancel it. The privacy notice and the deletion screen
must say all three plainly rather than implying a completeness the system cannot
deliver.
