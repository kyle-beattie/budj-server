## 1. Unblock

- [x] 1.1 ~~Determine whether App Review requires IAP.~~ **Resolved: IAP is
      required.** Section 5 is StoreKit 2 throughout; Stripe is not used. See D8.
- [x] 1.2 ~~Settle whether webhook subscription is per app or per user.~~
      Resolved: per user, after token exchange — but deferred to
      `add-rule-triggers` with the handler, since subscribing before the endpoint
      exists risks Akahu disabling it. No task here.
- [ ] 1.3 Decide the identity linking policy (open question 2) and record it.
      Affects whether section 4 gains a duplicate-detection task.

## 2. Prove the foundation

- [ ] 2.1 Get `pnpm db:start` running locally and `pnpm db:reset` applying
      `00000000000001_init.sql` for the first time. Fix whatever it turns out the
      migration got wrong.
- [ ] 2.2 Add an integration test harness that runs against the local stack,
      separate from `test/app.test.ts` and skipped when the stack is absent.
- [ ] 2.3 Integration test: signing up creates exactly one `profiles` row via the
      `handle_new_user` trigger.
- [ ] 2.4 Integration test: user A cannot select user B's `accounts` row through
      a user client. This is the first real proof the RLS policies work.
- [ ] 2.5 Integration test: PostgREST returns `numeric(14,2)` as a string, as
      `CLAUDE.md` asserts.

## 3. Schema

- [ ] 3.1 Edit `00000000000001_init.sql` in place — permitted only because it has
      never been applied to a real database. Note in the file that migrations are
      append-only from this change onward.
- [ ] 3.2 Rewrite `public.accounts`: drop `balance`, `institution`, `is_archived`
      and the `(user_id, lower(name))` unique index; add `akahu_account_id`,
      `connection_id`, `payment_from`, `payment_to`, `last_seen_at`,
      `disconnected_at`; add unique `(user_id, akahu_account_id)`. Two capability
      flags, not one — Akahu governs paying out and receiving differently.
- [ ] 3.3 Add `other` to the `account_type` enum as the fallback for unmapped
      Akahu types.
- [ ] 3.4 Add `akahu_tokens` (`user_id`, `akahu_user_id` indexed,
      `token_ciphertext`, timestamps). Enable RLS and deliberately declare **no
      policies**; comment saying so, or someone will "fix" it.
- [ ] 3.5 Add `akahu_connections` (`user_id`, `connection_id`, `name`,
      `connected_at`, `disconnected_at`) with owner RLS policies.
- [ ] 3.6 Add `billing_subscriptions` (`user_id`, `original_transaction_id`
      **unique**, `product_id`, `plan_code`, `status`, `expires_at`) with owner
      select-only RLS — the server writes it, the user never does. The unique
      constraint is what stops one App Store subscription entitling two accounts.
- [ ] 3.7 Add `device_registrations` (`user_id`, `device_id`, `public_key`,
      `apns_token`, `enrolled_at`, `revoked_at`) with owner RLS policies.
- [ ] 3.8 Add `apple_grants` (`user_id`, `refresh_token_ciphertext`, timestamps).
      Enable RLS with **no policies**, same as `akahu_tokens`.
- [ ] 3.8 Add `updated_at` triggers for every new table.
- [ ] 3.9 Change currency defaults from GBP to NZD in the migration.
- [ ] 3.10 `pnpm db:reset` then `pnpm types:generate`. Never hand-edit
      `database.types.ts`.

## 4. Identity

- [ ] 4.1 Rewrite `handle_new_user` to read `full_name` then `name` from the
      identity claims, falling back to `''` — never to the email local part.
- [ ] 4.2 Integration test: a signup whose only email is a
      `@privaterelay.appleid.com` address produces an empty display name, not a
      relay fragment.
- [ ] 4.3 Integration test: a signup carrying `full_name` in its metadata
      captures it.
- [ ] 4.4 Write down, for the iOS team, that Apple sends the user's real name
      **only on the first authorisation ever**. It must be included on the first
      `signInWithIdToken` call or it is unrecoverable.
- [ ] 4.5 Confirm the OpenAPI document contains no route accepting an Apple or
      Google *identity* token. The authorization-code route in 4.7 is the only
      permitted provider endpoint.
- [ ] 4.6 Apple client secret generation: an ES256 JWT signed with the key from
      Apple, regenerated before its six-month expiry. Add the key and team/key
      identifiers to `env.ts` and `.env.example`.
- [ ] 4.7 `POST /api/auth/apple/grant` — accept an authorization code, exchange it
      with Apple for a refresh token, encrypt and store it using the same helper
      as the Akahu token. Reuse the deny-all RLS table pattern. A failed exchange
      is recorded and does not fail sign-in.
- [ ] 4.8 Tell the iOS team the authorization code is **single-use and expires in
      about five minutes** — it must be posted during sign-in, in the same flow
      that captures Apple's one-shot name (4.4). Both are unrecoverable if missed.
- [ ] 4.9 Tests: a user client selecting from the Apple grant table gets zero
      rows; the stored token is ciphertext; re-submitting a code replaces rather
      than duplicates.

## 5. Billing

- [ ] 5.1 Add the App Store Connect API credentials to `env.ts` and
      `.env.example`: issuer id, key id, the `.p8` private key, bundle id and app
      Apple id. The suite fails at import without the latter file.
- [ ] 5.2 JWS verification helper: validate the x5c certificate chain to Apple's
      root and extract the payload. Used by both transaction submission and
      server notifications, so build it once with its own unit tests — a
      permissive implementation here grants free subscriptions to anyone.
- [ ] 5.3 Define the plan catalogue and entitlement resolver in code, mapping
      `plan_code` to App Store product identifiers. No table.
- [ ] 5.4 `billing.repository.ts` — read and write the cached entitlement row.
      Unique constraint on `original_transaction_id`.
- [ ] 5.5 App Store Server Notifications V2 endpoint, before anything that grants
      entitlement, so state can be observed before it can be made. Runs as
      service role; document why `requireAuth` does not apply.
- [ ] 5.6 Handle `SUBSCRIBED`, `DID_RENEW`, `DID_CHANGE_RENEWAL_STATUS`,
      `EXPIRED`, `DID_FAIL_TO_RENEW`, `GRACE_PERIOD_EXPIRED` and `REFUND`
      idempotently. Every notification ending entitlement runs the same
      revocation path (D9).
- [ ] 5.7 `POST /api/billing/transaction` — accept a signed StoreKit transaction,
      verify it, bind it to the authenticated user. Reject one already bound to a
      different user.
- [ ] 5.8 `GET /api/billing/plans` and `GET /api/billing/subscription`. No
      cancellation route: the server cannot cancel, and must not pretend to.
- [ ] 5.9 `requireSubscription` hook returning 402 `subscription_required`; apply
      to bank connections and rules, and deliberately not to onboarding status.
- [ ] 5.10 Tests: unverifiable notification rejected with no write; a transaction
      bound to another user refused; resubmission idempotent; unsubscribed caller
      gets 402 from a gated route and 200 from status; the OpenAPI document has
      no cancellation route.
- [ ] 5.11 Sandbox testing with a StoreKit configuration file, including a refund
      and an expiry. These are the paths that revoke bank access and they cannot
      be exercised in production.

## 6. Bank connections

- [ ] 6.1 Add the Akahu environment variables and `AKAHU_TOKEN_ENC_KEY` to
      `env.ts` and `.env.example`.
- [ ] 6.2 Envelope encryption helper with a key-version prefix on the ciphertext,
      so rotation is possible later. Unit tests for round trip and for rejecting
      an unknown key version.
- [ ] 6.3 `getAkahuToken(userId)` — the only non-admin service-role read in the
      codebase. It returns a credential and never a row. Comment it as the
      documented exception.
- [ ] 6.4 Integration test: a user client selecting from `akahu_tokens` gets zero
      rows. This is the load-bearing assertion of the whole custody design.
- [ ] 6.5 Akahu client wrapper: authorisation URL construction, code exchange,
      `GET /accounts`, `GET /connections`, `DELETE /token`.
- [ ] 6.6 `POST /api/bank-connections/authorise` — issue an authorisation URL with
      a single-use expiring `state` bound to the user, and the exact five scopes
      from D7. Assert in a test that `payments` and `accounts:balance` are absent.
- [ ] 6.7 Redirect handler: validate and consume `state`, exchange the code,
      encrypt and store the token, record the connection, sync accounts. Ensure
      no code path writes a plaintext token, even transiently.
- [ ] 6.8 Account projection sync: upsert on `(user_id, akahu_account_id)`, map
      Akahu types with an `other` fallback, set `payment_from` from the
      `PAYMENT_FROM` attribute and `payment_to` from BECS eligibility, set
      `last_seen_at`, and mark accounts absent from the response as disconnected
      rather than deleting them.
- [ ] 6.9 Enforce the plan's connection limit before starting authorisation.
- [ ] 6.10 `GET /api/bank-connections` and a revoke route that marks the
      connection and its accounts disconnected.
- [ ] 6.11 Tests: reused `state` refused; duplicate account names both stored;
      unmapped account type does not abort the sync; revoking marks rather than
      deletes.

## 7. Accounts rewrite

- [ ] 7.1 Delete the create, update and delete routes, their DTOs, and their
      repository methods.
- [ ] 7.2 Rewrite `accountSchema` for the projection: no balance, no account
      number, plus `akahuAccountId`, `connectionId`, `paymentEligible`,
      `disconnectedAt`.
- [ ] 7.3 Update `test/app.test.ts` — the guarded-route assertions for the
      removed verbs must become assertions that the routes are gone.
- [ ] 7.4 Test: a response for an account contains no balance field.

## 8. Devices

- [ ] 8.1 `POST /api/devices` — register device id, P-256 public key, optional
      APNs token. Upsert on `(user_id, device_id)`.
- [ ] 8.2 Validate the public key is a well-formed P-256 point; reject anything
      else with 400. Ensure the schema has no field a private key could occupy.
- [ ] 8.3 `GET /api/devices` and `DELETE /api/devices/:deviceId`, marking revoked
      rather than deleting.
- [ ] 8.4 Tests: two devices coexist; re-registering one device replaces its key;
      revoking someone else's device returns 404.

## 9. Onboarding status

- [ ] 9.1 `GET /api/onboarding/status` deriving the step in the order billing,
      bank, device, ready, with push reported as advisory.
- [ ] 9.2 Guard with `requireAuth` but deliberately **not** with
      `requireSubscription`.
- [ ] 9.3 Tests: one per step transition; a complete user with no APNs token
      still reports `ready`; an anonymous caller gets 401.
- [ ] 9.4 Assert no generated type carries an onboarding step column.

## 10. Client contract and version gating

- [ ] 10.1 `requireSupportedClient` hook reading the build identifier from every
      request. A missing identifier is unsupported, not exempt — a client that
      cannot be identified cannot be gated. Exempt the App Store notification and
      Akahu webhook routes, which are not client requests.
- [ ] 10.2 Environment-driven minimum supported build and a blocked-build range
      for money-moving operations, kept separate. Environment, not a table: this
      must change during an incident without a migration.
- [ ] 10.3 A distinguishable error code for "update required", separate from
      authentication and subscription failures, so the app can prompt correctly.
- [ ] 10.4 Money-movement gate applied where payments are initiated. Nothing
      initiates payments in this change, so wire the hook and prove it refuses;
      `add-rule-triggers` inherits a working gate.
- [ ] 10.5 Emit `contract/openapi.json` from the generated document as a tagged
      release artifact.
- [ ] 10.6 Write `contract/money-vectors.json`: decimal strings to integer cents
      including rounding cases, and assert the server's own implementation
      against them in CI.
- [ ] 10.7 Tests: a below-minimum build refused with the update code; a request
      with no build identifier refused; a blocked build refused only for
      money-moving routes; webhooks unaffected.

## 11. Wiring and documentation

- [ ] 11.1 Register `billing`, `bank-connections`, `devices` and `onboarding` in
      `src/modules/index.ts`.
- [ ] 11.2 Update `test/app.test.ts` for the new mount points and guards.
- [ ] 11.3 Update `CLAUDE.md`: the two service-role exceptions (D5), accounts as a
      projection rather than a user-owned table (D6), the client version gate
      (D15), the new modules, the new environment variables, and the fact that an
      integration suite now exists.
- [ ] 11.4 Update `.env.example` with every new variable and confirm
      `pnpm test` passes from a clean checkout with placeholders only.
- [ ] 11.5 Write the key runbook: `AKAHU_TOKEN_ENC_KEY` — where it lives, what
      breaks if it is lost, how to rotate using the version prefix — and the
      Apple signing key, which expires every six months and silently breaks the
      code exchange when it does. Closes open question 4.
- [ ] 11.6 Tell the iOS repo what to pin: the contract tag, the vectors to run in
      its own CI, and that every request must carry a build identifier.
- [ ] 11.7 `pnpm typecheck && pnpm test` clean, and the OpenAPI document
      generates.
