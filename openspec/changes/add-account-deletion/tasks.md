## 1. Prove the cascade before relying on it

- [ ] 1.1 Write the cascade coverage test: enumerate every table in `public` and
      assert each either cascades from `auth.users` or appears in an explicit
      exemption list. Run it against the schema as it stands — expect it to find
      something.
- [ ] 1.2 Fix whatever it finds, in the migration that introduced the table.
- [ ] 1.3 Integration test: deleting a user via the admin API removes every row
      belonging to them across all application tables.

## 2. Tables that must outlive the user

- [ ] 2.1 Migration: `account_deletions` — user id as a plain `uuid` with **no
      foreign key** to `auth.users`, per-step completion marks, requested and
      completed timestamps, and a field recording whether the Apple grant was
      revocable. Comment why the FK is absent; it looks like an oversight.
- [ ] 2.2 Migration: `orphaned_payments` — payment id, amount, currency,
      timestamps, outcome. No user, account, transaction or rule identifier. Same
      absence of a foreign key.
- [ ] 2.3 Add both to the exemption list in 1.1, so the coverage test documents
      them as deliberate rather than failing.
- [ ] 2.4 `pnpm db:reset && pnpm types:generate`.

## 3. The shared revocation routine

- [ ] 3.1 Extract `revokeExternalAccess(userId)` from the subscription lapse
      handler: revoke consents, unsubscribe webhooks, revoke the Akahu token — in
      that order.
- [ ] 3.2 Make every step idempotent. A 404 from a revoke, or a subscription
      already cancelled, is success — the desired state has been reached.
- [ ] 3.3 Switch the lapse handler to the extracted routine. No behaviour change;
      verifiable on its own before deletion exists.
- [ ] 3.4 Test: running the routine twice for one user changes nothing the second
      time.

## 4. The teardown worker

- [ ] 4.1 Cron entry point for pending deletions, extending the worker added in
      `add-rule-triggers`. Exponential backoff, resumable from per-step marks.
- [ ] 4.2 Step 1: invalidate pending executions; attempt
      `PUT /payments/{id}/cancel` for initiated payments.
- [ ] 4.3 Step 1b: create an `orphaned_payments` stub for any payment that could
      neither be cancelled nor confirmed terminal. Never wait for settlement.
- [ ] 4.4 Steps 2–4: call `revokeExternalAccess(userId)` from section 3.
- [ ] 4.5 Step 5: end local entitlement and record whether the store subscription
      was left live. Attempt no cancellation — Apple provides no such endpoint,
      and code that pretends otherwise is worse than an honest record.
- [ ] 4.6 Step 6: revoke the Apple grant via `POST appleid.apple.com/auth/revoke`.
      A user with no stored grant is recorded as unrevoked, not as success. This
      is Sign in with Apple, unrelated to the subscription.
- [ ] 4.7 Step 7: global sign-out via the admin client.
- [ ] 4.8 Step 8: `auth.admin.deleteUser`, then mark the deletion record
      complete.
- [ ] 4.9 **Ordering test**: assert the relative order of the external calls, not
      merely that each was made. This is the test that matters — wrong order
      fails silently and leaves a live bank consent.
- [ ] 4.10 Test: a failure at step 5 is retried without repeating steps 1–4.
- [ ] 4.11 Test: a crash immediately after step 9 leaves the deletion record
      intact and the job resumes to mark it complete.
- [ ] 4.12 Alert when a deletion has not completed within 24 hours. This pages
      someone; it is not a log line.

## 5. The endpoint

- [ ] 5.1 `POST /api/account/deletion` — issue and verify a challenge signature
      using the approval path from `add-rule-triggers`, then record the deletion
      and revoke the session.
- [ ] 5.1a `GET /api/account/deletion/preview` — report whether entitlement is
      active, so the app can warn that deletion will not stop the charging and
      offer a deep link to App Store subscription management. Warn, never block.
- [ ] 5.2 Confirm no route exists that cancels or reverses a deletion.
- [ ] 5.3 Tests: valid token without a signature refused; reused nonce refused;
      anonymous caller gets 401 before validation.

## 6. Closing the token window

- [ ] 6.1 Extend the subscription gate to resolve deletion state in the same
      lookup and refuse deleting accounts.
- [ ] 6.2 Test: an access token issued before deletion cannot approve a pending
      execution afterwards. This is the specific hole — local JWKS verification
      performs no revocation check.
- [ ] 6.3 Comment the hook to say why the check lives there, since "we called
      signOut, they are locked out" is the natural and wrong assumption.

## 7. Late arrivals

- [ ] 7.1 Settle `orphaned_payments` stubs from payment webhook events, and purge
      each once its payment reaches a terminal state.
- [ ] 7.2 Test: a payment event arriving for a deleted user updates the stub
      rather than being discarded.

## 8. Documentation

- [ ] 8.1 Update `CLAUDE.md`: the teardown ordering invariant, the two
      deliberately non-cascading tables, and the shared revocation routine.
- [ ] 8.2 Privacy notice copy — what is deleted, that Akahu retains its own
      record as a separate data controller, that Apple retains purchase records,
      that an active subscription keeps billing until cancelled in App Store
      settings, and that deletion cannot be undone.
- [ ] 8.3 Resolve open question 1: how long an `orphaned_payments` stub may
      survive a payment that never reaches a terminal state, so the exception
      does not become a retention policy by accident.
- [ ] 8.4 `pnpm typecheck && pnpm test` clean; OpenAPI generates.
