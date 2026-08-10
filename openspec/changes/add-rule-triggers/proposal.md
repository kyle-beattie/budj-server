## Why

`add-onboarding` leaves a paying user with a connected bank, a registered device,
and nothing to do. This change is the product: a rule fires when money arrives,
the user is notified, and on biometric approval money moves between their own
accounts.

The rules module cannot support that today. Its matcher is sound — pure, priority
ordered, `stopProcessing` honoured — but all five of its actions
(`set_category`, `add_tags`, `set_note`, `set_account`, `ignore`) annotate a
transaction row that this product never stores. Every one of them is a no-op.
Meanwhile the engine has no way to express "money received", compares amounts as
floats, and types account identifiers as UUIDs when Akahu issues opaque strings.

Nothing has ever been written to `rules.conditions` or `rules.actions`, so the
redesign costs a migration of zero rows. It will not stay that cheap.

## What Changes

- **BREAKING: rule actions become effects.** `set_category`, `add_tags`,
  `set_note` and `set_account` are removed outright. `notify` and `transfer`
  replace them. `ignore` survives with a new meaning: produce no proposal at all.
- **BREAKING: `direction` becomes a condition field.** "Money received" is not
  expressible today. Amount sign conventions are not relied upon.
- **BREAKING: money leaves floating point.** Amounts are parsed from decimal
  strings to integer cents and computed in `bigint`. Percentage transfers round
  down, always, so a rule can never move more than the user was shown.
- **BREAKING: `accountId` becomes an opaque string.** Akahu issues `acc_…`, not
  a UUID, in both conditions and effects.
- **Transaction ingestion.** A per-user Akahu webhook subscription, RSA-SHA256
  signature verification, reverse lookup from the Akahu user id, and a
  reconciliation sweep because Akahu retries for a day and then gives up.
- **The pending execution.** One table serving as idempotency ledger, audit log,
  approval queue, and the iOS app's main read model. It stores a transaction id
  and the user's own instruction — never an amount, merchant, or description
  belonging to Akahu.
- **Biometric approval.** The device key enrolled during onboarding is finally
  used: the server issues a challenge, the app signs it in the Secure Enclave,
  and the signature commits to the exact amount. A stolen session token cannot
  move money.
- **Akahu enduring payment consent.** Requested at first money-moving rule
  rather than during onboarding, because a consent is bound to one payer account
  and its payees must be known in advance. Rules gain a `pending_consent` state.
- **Thin push notifications.** The APNs payload carries an execution id and a
  generic title. Amounts are fetched over TLS by the app, never routed through
  Apple.
- **Scheduled work.** Render cron for proposal expiry and webhook reconciliation
  — the first background process in this service.

## Capabilities

### New Capabilities

- `rule-effects`: The redesigned condition and effect vocabulary, the `direction`
  field, integer-cent money arithmetic, rule lifecycle including
  `pending_consent`, and validation of a rule against its consent limits.
- `transaction-ingestion`: Webhook subscription, signature verification, user
  reverse lookup, deduplication, settled-versus-pending handling, and the
  reconciliation sweep.
- `execution-approval`: The pending execution lifecycle, challenge issue and
  signature verification, compare-and-swap state transitions, asynchronous
  payment settlement, and expiry.
- `payment-consent`: Requesting enduring payment consent, payee verification
  tokens, single and periodic limits, consent reuse by label, and invalidation on
  revocation or disconnection.
- `notifications`: Thin APNs delivery, the durable in-app pending list, and
  behaviour when push fails or was never permitted.

### Modified Capabilities

- `bank-connections`: The account projection gains a distinction between paying
  *from* an account and paying *to* one, which `add-onboarding` conflated into a
  single `payment_eligible` flag. Akahu exposes a `PAYMENT_FROM` attribute for the
  former and BECS identifiability governs the latter. Webhook subscription is
  added to the token exchange.

## Impact

**The security posture of the whole service changes.** This is the first code
that moves money. Four independent controls are load-bearing, and the design
document names them; the one that matters most is that `POST /payments` has **no
documented idempotency mechanism**, so a compare-and-swap on a Postgres row is
the only thing preventing a duplicated payment.

**Database.** `pending_executions`, `payment_consents`, `processed_webhooks`; new
columns on `rules` for lifecycle. Append-only migrations from here — the
in-place edit permitted in `add-onboarding` is not repeated.

**Architecture.** A second unauthenticated-but-signed inbound path (the Akahu
webhook), joining the App Store one. A background worker, which this service has
never had. `CLAUDE.md` needs both.

**Modules.** New `executions` and `webhooks` modules; substantial rewrite of
`rules`; additions to `bank-connections` and `devices`.

**Existing code removed.** `rules.types.ts` loses four of five action variants;
`rules.engine.ts` loses `applyAction`'s annotation folding and its
`compareNumeric` float path; `evaluateRulesResponseSchema.outcome` is replaced
entirely.

**External dependencies.** An APNs client, a crypto library for RSA-SHA256
verification and ES256 signature verification, and a decimal helper (or hand
rolled `bigint` cents — likely the latter, it is thirty lines).

**Risk.** A defect here debits a real person's bank account. The test suite for
the approval path is not optional and the tasks treat it as blocking.
