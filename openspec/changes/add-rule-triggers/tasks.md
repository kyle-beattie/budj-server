## 1. Unblock

- [ ] 1.1 Confirm `INITIAL_UPDATE` should be ignored entirely and only
      `DEFAULT_UPDATE` acted upon (open question 1). Getting this wrong sends a
      new user months of proposals at once.
- [ ] 1.2 Read the transactions API pagination contract and choose the
      reconciliation cursor (open question 2). A timestamp cursor risks gaps at
      boundaries.
- [ ] 1.3 Confirm what obligations fall to this application, versus Akahu, for
      initiating payments on a user's behalf in New Zealand.
- [ ] 1.4 Amend `add-onboarding` for the two-way payment capability flag before
      that change is implemented, so the projection is not built twice.

## 2. The engine, proven in isolation

The engine is pure, so all of section 2 can be finished and tested before any
integration exists.

- [ ] 2.1 Money helpers: decimal string to `bigint` cents and back, percentage
      with round-down. Unit tests including `7.5%` of `1033.33` equals `77.49`.
- [ ] 2.2 Replace `transactionCandidateSchema.amount` with the decimal-string
      money schema. Delete `compareNumeric` and its float path.
- [ ] 2.3 Add `direction` to `ruleFieldSchema` and to the transaction candidate.
- [ ] 2.4 Change `accountId` from `z.uuid()` to an opaque string in conditions,
      effects and the candidate.
- [ ] 2.5 Replace `ruleActionSchema` with `notify`, `transfer` and `ignore`.
      Delete `set_category`, `add_tags`, `set_note`, `set_account`.
      A percentage amount carries `of: 'original'` explicitly (E3). It reads as a
      redundant field with only one legal value today; it is the hook
      `add-rule-allocation` needs, and adding it after rules exist is a jsonb
      migration over live data.
- [ ] 2.6 Rewrite `applyAction` and `evaluateRulesResponseSchema.outcome`: fold to
      an effect list, and make `ignore` suppress the proposal entirely.
- [ ] 2.7 Bound the `matches` operator — pattern length cap, nested-quantifier
      rejection at write time, and a time budget during evaluation. Test that a
      catastrophic pattern does not stall other rules.
- [ ] 2.8 Update `test/rules.engine.test.ts` throughout, keeping the existing
      priority and `stopProcessing` coverage.

## 3. The duplicate-payment defence, before anything can pay

- [ ] 3.1 Migration: `pending_executions` with unique `(user_id, akahu_txn_id)`,
      a `source` column recording `webhook` or `reconciliation`, and an
      `updated_at` trigger. Append-only from here.
      **RLS is select-only for the owner** — one `select` policy on
      `auth.uid() = user_id`, and deliberately no insert, update or delete
      policy, the way `public.profiles` is written. Do not copy the four-policy
      owner-CRUD block from `accounts` or `rules`: an insertable
      `pending_executions` lets a session forge an execution and approve it,
      bypassing the rule engine entirely. Carry a comment in the migration saying
      so, since the omission otherwise reads as an oversight.
- [ ] 3.1a Tests that a user's own client is refused on direct insert, update and
      delete of `pending_executions`, and permitted on select. These assert the
      absence of a policy, which nothing else would catch.
- [ ] 3.2 Migration: `payment_consents` and the new `rules` lifecycle column.
- [ ] 3.3 `pnpm db:reset && pnpm types:generate`.
- [ ] 3.4 Repository with the compare-and-swap transition. Comment that the
      `.eq('status', …)` is the concurrency control, not a filter — it will
      otherwise be "tidied" away.
- [ ] 3.5 Concurrency test: two approvals in parallel, assert exactly one
      transition succeeds. This test gates everything in section 6.
- [ ] 3.6 Test the unique constraint under concurrent insert: exactly one row,
      neither caller errors.

## 4. Ingestion — real end to end, still unable to move money

- [ ] 4.1 Akahu signature verification: RSA-SHA256 PKCS1 over the raw body,
      `X-Akahu-Signature` and `X-Akahu-Signing-Key`. Fastify must expose the raw
      body for this route.
- [ ] 4.2 Signing key cache, with the key identifier validated before it is used
      to build a fetch URL.
- [ ] 4.3 Webhook route: verify, resolve the user by reverse lookup on
      `akahu_user_id`, never from the body.
- [ ] 4.4 Ignore `INITIAL_UPDATE`; act on `DEFAULT_UPDATE`; act on settled
      transactions only.
- [ ] 4.5 Evaluate rules and insert the folded proposal, relying on the unique
      constraint rather than a read-then-write check.
- [ ] 4.6 Handle `TOKEN`/`DELETE`, `ACCOUNT`/`DELETE` and `WEBHOOK_CANCELLED` —
      mark disconnected, invalidate pending executions, and notify the user.
      Email, if used, needs an admin lookup: no email is stored anywhere.
- [ ] 4.9 Pause the subscription when a connection stays disconnected beyond the
      configured window, so nobody is charged for a service that cannot run.
- [ ] 4.10 Log payment events for unresolvable users at warning level rather than
      discarding them — the deleted-user-with-settling-payment case.
- [ ] 4.7 Assert in a test that no code path from the webhook handler reaches
      payment initiation.
- [ ] 4.8 Tests: unsigned rejected, tampered body rejected, redelivery creates
      nothing, unknown Akahu user discarded, pending transaction ignored.

## 5. Notifications

- [ ] 5.1 APNs client and credentials in `env.ts` and `.env.example`.
- [ ] 5.2 Thin payload: execution id and generic title only. Test that no amount
      or account name appears in the payload.
- [ ] 5.3 Deliver to registered, unrevoked devices; clear tokens APNs reports as
      invalid.
- [ ] 5.4 `GET /api/executions?status=pending` — the durable in-app list, plus a
      badge count. Not optional: it is the fallback when push fails.
- [ ] 5.5 Test: a user with no APNs token can still list and approve.

**Milestone.** At the end of section 5 the system is real end to end — rules fire
on live transactions and users are notified — while remaining structurally
incapable of moving money. Worth stopping here and using it.

## 6. Consent

- [ ] 6.1 Read `payment_consents` and the `PAYMENT_FROM` attribute from
      `GET /accounts`; derive coverage from Akahu rather than local state.
- [ ] 6.2 Generate account verification tokens on demand. Assert in a test that
      none is ever persisted.
- [ ] 6.3 Build the authorisation request: label `payer:<account_id>`, the union
      of destinations for that payer, both limits mandatory.
- [ ] 6.4 Redirect handler: record the consent, activate rules that were
      `pending_consent`.
- [ ] 6.5 Rule creation returns an authorisation URL when the destination is
      uncovered, and stores the rule as `pending_consent`.
- [ ] 6.6 Warn at rule creation when the largest possible transfer exceeds the
      consent's single limit.
- [ ] 6.7 Revocation route, and invalidation of dependent rules and pending
      executions on revoke, disconnect, or token deletion.
- [ ] 6.8 Tests: same payer and destination needs no redirect; adding a
      destination preserves the existing ones; revocation invalidates in flight.

## 7. Approval and payment

Section 3.5 must be green before starting.

- [ ] 7.1 `POST /api/executions/:id/approve` — authentication only:
      compare-and-swap to `executing`, then initiate payment. In that order. The
      CAS is the sole duplicate-payment defence on this path (E11), so write the
      parallel-approve concurrency test alongside it, not afterwards.
- [ ] 7.2 Ignore any effect amounts present in the approval body; the stored
      effects are what execute. Test that a body restating a different amount
      does not change what is paid.
- [ ] 7.3 `POST /api/executions/:id/decline` — authentication only.
- [ ] 7.4 Payment initiation: fetch the destination account number and holder
      name from Akahu at call time. Never store either.
- [ ] 7.5 Record the Akahu payment id per effect. Do not report success from the
      initiation response.
- [ ] 7.6 Payment webhook events settle each effect; retain `status_code` and
      `status_text` for failures.
- [ ] 7.7 Tests: anonymous approval returns 401; approving a resolved execution
      refused; another user's execution returns 404; two parallel approvals
      initiate exactly one payment.

## 8. Scheduled work

- [ ] 8.1 Render cron entry point — this service's first background process.
- [ ] 8.2 Expiry sweep, 48 hour default TTL.
- [ ] 8.3 Reconciliation sweep using the cursor chosen in 1.2, skipping
      transactions that already have a row.
- [ ] 8.4 Webhook subscription at token exchange, plus an idempotent backfill for
      users onboarded before this change.
- [ ] 8.5 Tests: the sweep recovers a missed transaction and does not duplicate a
      delivered one.

## 9. Wiring and documentation

- [ ] 9.1 Register the `executions` and `webhooks` modules in
      `src/modules/index.ts`; update `test/app.test.ts`.
- [ ] 9.2 Update `CLAUDE.md`: the webhook may-not-pay invariant (E5),
      compare-and-swap as the only concurrency primitive (E6), the ordering rule
      (E7), the background worker, and the new modules.
- [ ] 9.3 Republish `contract/openapi.json` at a new tag; tell the iOS repo the
      approval endpoint takes no signature and there is no challenge call.
- [ ] 9.4 `.env.example` complete; `pnpm typecheck && pnpm test` clean from a
      fresh checkout; OpenAPI generates.
