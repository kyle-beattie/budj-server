## Context

The server today has a Fastify + Supabase skeleton: an auth proxy over GoTrue,
a `profiles` table seeded by trigger, a user-owned `accounts` table, and a rules
module whose engine is pure and well-formed but whose actions annotate
transactions the system does not store.

The product is not a budgeting app. It is automation over a bank feed: a rule
matches an inbound transaction, the user receives a push notification, and on
approval money moves between the user's own accounts. Nothing is categorised and
no spending history is kept.

Three constraints shape everything below.

**Store as little as possible.** Transactions are never persisted. Balances are
never persisted. What is stored is the user's own instructions and the minimum
required to make them work.

**Akahu is a New Zealand aggregator and the sole source of account data.** The
user's connected accounts are facts retrieved from Akahu, not records the user
creates. Akahu bills per connected user, so a connection has a direct running
cost.

**The client is a native iOS app and the server is always in the middle.** The
app never holds an Akahu token and never calls Akahu.

Two findings from the Akahu documentation constrain the sequencing, and are the
reason this change stops where it does:

- An `enduring_payment_consent` authorisation request is bound to a single payer
  account (`_account`: "The ID of the account to request enduring payment consent
  for"). A user who wants rules on three accounts needs three consents.
- A consent can only pay the payees named in the request, and payees must come
  from a verified source. You cannot know the payee set until after the accounts
  have been discovered, which requires a prior authorisation.

Payment consent therefore cannot be folded into the first bank redirect, and this
change does not attempt it.

## Goals / Non-Goals

**Goals:**

- A person can go from first launch to a resumable, complete onboarding: signed
  in, subscribed, bank connected, device registered.
- The Akahu user access token is stored such that neither the iOS app nor a
  compromised user JWT can reach it.
- Multiple bank connections per user, added at any time, not only at onboarding.
- Onboarding state is computed from reality, never asserted by a column.
- The scopes requested during onboarding are the ones the product needs for its
  read path, chosen once, because widening them later costs a bank redirect.

**Non-Goals:**

- Moving money. No `payments` scope, no enduring payment consent, no payee
  verification, no approval endpoint. All of that is `add-rule-triggers`.
- Transaction ingestion. No Akahu webhook subscription, no `pending_executions`.
- The rule action redesign. The five annotation actions remain wrong and remain
  in place; this change does not touch `rules`.
- Verifying Secure Enclave signatures. Only enrolment of the public key.
- Any user-facing surface for viewing transactions or balances.

## Decisions

### D1. Onboarding status is derived, never stored

`GET /api/onboarding/status` computes the step from facts that must exist anyway:

```
  !subscriptionActive  → 'billing'
  !akahuToken          → 'bank'
  !deviceKeyRegistered → 'device'
  !apnsToken           → 'push'        (advisory — see D12)
  else                 → 'ready'
```

*Alternative considered:* an `onboarding_step` column on `profiles`. Rejected
because it can disagree with reality — a user who has paid but whose column still
reads `billing` is a support ticket with no self-service fix — and because every
new step becomes a migration plus a backfill. The inputs are all local single-row
lookups, so derivation costs one query.

### D2. OAuth is client-to-Supabase; this server only ever verifies the JWT

The existing auth module is a proxy: client → Fastify → GoTrue. That shape works
for email/password and does not work for OAuth. For native Apple and Google
sign-in the app obtains an identity token from the platform SDK and calls
Supabase's `signInWithIdToken` **directly**, then presents the resulting Supabase
JWT to this server.

Consequence: `requireAuth` and the JWKS verification in `auth.plugin.ts` are
unchanged and cover OAuth users for free. The auth module's credential endpoints
become the fallback path rather than the main one, and no new proxy endpoints are
added for Apple or Google.

*Alternative considered:* proxying the OAuth redirect flow through Fastify with
PKCE. Rejected — it is the web shape, it adds a browser round trip on a native
client, and it puts this server in the middle of a flow it adds nothing to.

**Qualified by D13.** The *identity* token still goes straight to Supabase and
this server never sees it. Apple's *authorization code* is a separate artifact
and must come here, for reasons that only become visible at account deletion.

### D3. `handle_new_user` must stop deriving names from email addresses

The trigger currently falls back to `split_part(new.email, '@', 1)`. Apple's
Hide My Email produces `xyz@privaterelay.appleid.com`, so that fallback names
people `xyz`. Worse, **Apple supplies the user's real name exactly once**, on the
first authorisation ever; if it is not captured then it is unrecoverable without
the user revoking the app in iOS settings.

The trigger reads `full_name` and `name` from the OAuth identity claims before
falling back, and falls back to empty rather than to an email local-part. The iOS
app must send the name on its very first `signInWithIdToken` call, and this is
called out in tasks because it is a one-shot with no retry.

Related: the private relay address means **email cannot be used as a join key**
to anything — which is one reason entitlement is keyed by the App Store's
`original_transaction_id` rather than by any identity Apple gives you (D8).

### D4. Akahu token custody: deny-all RLS plus envelope encryption

The Akahu user access token is a bearer credential for someone's bank. It is
stored in `akahu_tokens`, a table with RLS **enabled and no policies at all** —
which makes it unreadable through the anon and user clients, since PostgREST
denies by default. Only the service-role client can read it.

The token is additionally encrypted with a key held in the environment
(`AKAHU_TOKEN_ENC_KEY`), not in Postgres, so a database dump alone does not
yield bank access for every user.

*Alternatives considered:* storing it on `profiles` under normal owner-RLS —
rejected, because the iOS app could then read it and bypass the server, and a
leaked JWT would escalate from "read your budget" to "read your bank". Supabase
Vault — viable, and the encryption story is comparable; rejected for now because
it couples key custody to the database platform and makes local testing heavier.

### D5. A narrow, named exception to the service-role rule

`CLAUDE.md` states the service-role client is admin-only and must never serve a
normal request. D4 forces a second use. The exception is written down rather than
allowed to erode:

> The service client may fetch a credential keyed by `userId`. It must never
> return a database row to a caller. `getAkahuToken(userId)` is the only
> non-admin service-role read in the codebase.

The App Store Server Notifications handler is a second, structurally different
exception: it is authenticated by a JWS certificate chain rather than by JWT, so
`requireAuth` cannot apply and the handler runs as service role. It is not
user-initiated and returns nothing.

Both go into `CLAUDE.md` as part of this change. An undocumented exception
becomes a precedent within a month.

### D6. Accounts become a thin projection, not a cache and not a copy

`public.accounts` is rewritten. It holds what is needed to render a rule editor
and to prove ownership; it does not hold financial data.

```
  kept        akahu_account_id, connection_id, name, type,
              payment_eligible, last_seen_at, disconnected_at
  dropped     balance          (live from Akahu; a stale balance is worse
                                than no balance)
              institution      (comes from the connection now)
              is_archived      (Akahu owns the lifecycle)
  dropped     unique (user_id, lower(name))
                               (Akahu can legitimately return two accounts
                                with the same name)
  added       unique (user_id, akahu_account_id)
```

The reason to keep a table at all is **not** caching. It is that Postgres cannot
enforce tenancy over Akahu data, so a rule referencing `acc_stranger` would
otherwise have to be validated by an Akahu round trip or not at all. A local row
under RLS restores the second guard that `CLAUDE.md` calls deliberate.

*Alternatives considered:* dropping the table and holding raw Akahu ids in rules
— rejected, no ownership check and no way to render a rule list without a network
call. Storing balances too — rejected, it is the highest-sensitivity field
available and it is stale the moment it is written.

Payment capability is recorded in **two** directions, because Akahu governs them
differently: `payment_from` follows the `PAYMENT_FROM` attribute Akahu reports on
the account, and `payment_to` follows BECS identifiability, which is what allows
a verification token to be issued. An account can be one and not the other.
Credit cards, loans and investment accounts can trigger rules but can never
receive money, and the rule editor needs to know that before `add-rule-triggers`
exists.

Akahu's account type vocabulary does not match the existing `account_type` enum.
The mapping lives in the module, with an explicit `other` fallback so an unknown
type from Akahu degrades rather than failing the sync.

### D7. Scopes are chosen now, deliberately, and `payments` is not among them

Requested at connection: `accounts:basic`, `accounts:owner`,
`transactions:credits`, `transactions:debits`, `user:basic`.

- `accounts:owner` is required to generate the account verification tokens that
  `add-rule-triggers` will need. Requesting it now avoids a second redirect later
  purely to widen read consent.
- `transactions:credits` and `transactions:debits` **must be requested as a
  pair** even though only credits are of interest. Privacy copy should say so
  plainly, along with the fact that neither is stored.
- `user:basic` yields the Akahu user id, which is the reverse-lookup key the
  transaction webhook will need. Cheap now, awkward later.
- `accounts:balance` is **not** requested. Nothing in the product reads a
  balance, and asking for it would be inconsistent with the privacy position.

### D8. StoreKit 2 in-app purchase, with entitlement owned here

App Review requires in-app purchase for this subscription; Stripe is not
available. Purchases are made with StoreKit 2 in the app, and the server learns
about them two ways: the app submits the signed transaction after purchase, and
App Store Server Notifications V2 report every subsequent change.

What survives from the original Stripe design, unchanged:

- **`billing_subscriptions` is *your* entitlement record**, keyed by your
  `user_id`. The store knows about a purchase; only this table knows which
  account it entitles. Everything downstream reads it and is unaffected by who
  took the payment.
- **Notification-driven, never polled.** Same shape as the Stripe webhook, a
  different sender and a different verification scheme.
- **Entitlements in code**, keyed by `plan_code`:

```ts
{ starter: { maxRules: 10, maxConnections: 2, effects: ['notify'] },
  pro:     { maxRules: 100, maxConnections: 10, effects: ['notify', 'transfer'] } }
```

  *Alternative considered:* a `plans` table. Rejected — a migration every time a
  limit changes, and it is data that does not need to be stored.

What changes:

- `stripe_customer_id` is replaced by Apple's `original_transaction_id`, which is
  the stable key across renewals. **Unique**, so one Apple subscription cannot
  entitle two accounts — without that constraint, subscription sharing is a
  one-line exploit.
- Verification is JWS with an x5c certificate chain to Apple's root, not an HMAC
  shared secret. Both the submitted transaction and the server notifications are
  verified this way.
- There is no customer object, no card on file, no proration control, and no
  dunning to configure. Apple owns all of it.

*Alternative considered:* web-based signup with Stripe, the "reader app" pattern
— the app cannot mention or link to it. Rejected: with no free tier the billing
gate is the second screen, and an onboarding flow that cannot tell the user where
to pay is not an onboarding flow.

### D9a. Refunds and expiry are notifications, not decisions

Apple decides refunds and tells you afterwards. `REFUND`, `EXPIRED`,
`DID_FAIL_TO_RENEW` and `GRACE_PERIOD_EXPIRED` all resolve to the same local
outcome — entitlement ends — and therefore all run D9's revocation path.

This is a genuine loss of control worth naming: a user can be refunded a month
you have already served, and the first you hear of it is the notification.

### D9. A lapsed subscription revokes the Akahu token

There is no free tier. When entitlement ends — expiry, refund, failed renewal, or
the user cancelling in App Store settings — the handler revokes the Akahu token
via `DELETE /token` and marks connections disconnected. It does not merely gate
the UI.

Two reasons: Akahu bills per connected user, so a gated-but-connected cancelled
account is a recurring cost with no revenue; and once `add-rule-triggers` lands,
a connection that still receives transaction events for a non-paying user is a
system doing work nobody authorised.

### D10. Secure Enclave enrolment happens here; verification happens later

The app generates a P-256 key in the Secure Enclave with `.biometryCurrentSet`
and registers the public key. This change stores it and does nothing else with
it.

The reason it belongs in onboarding rather than in `add-rule-triggers`: Face ID
that merely unlocks a Keychain-held refresh token is a *client-side* gate. The
server sees an ordinary bearer token either way and cannot distinguish a fresh
biometric from a replayed session. For approving a payment that distinction is
the whole point, so approval must require a signature over a server-issued
challenge — and the key has to be enrolled before the first rule exists.

`.biometryCurrentSet` invalidates the key when biometrics change, which is the
secure choice and obliges a re-enrolment path. Re-enrolment is authorised by a
valid session; hardening that further is deferred with the rest of the approval
flow.

### D11. Verification tokens are regenerated on demand, never stored

Decided in exploration and recorded here because the temptation will recur: Akahu
account verification tokens are reusable and application-agnostic, so caching
them would save a call. They are not cached. A stored verification token is a
persisted assertion about a real person's name and bank account number, which is
exactly the class of data this design refuses to hold. The saved round trip is
not worth it.

(No verification tokens are generated by this change at all. The decision is
recorded so `add-rule-triggers` inherits it.)

### D12. Push registration is encouraged and skippable

Notifications are the product's critical path — a rule that cannot notify cannot
be approved. But permission denial must not brick the app, so onboarding treats
`push` as advisory: `GET /api/onboarding/status` reports it, and `ready` does not
require it. The durable surface is an in-app pending list, which
`add-rule-triggers` provides.

### D13. Apple's authorization code is captured at sign-in, or revocation is impossible forever

Apple requires apps offering Sign in with Apple to revoke the user's tokens when
their account is deleted. That call needs an Apple refresh token, and **Supabase
does not provide one**: for the native `signInWithIdToken` flow
`providerAccessToken` and `providerRefreshToken` are nil, and revocation is a
known open gap in the project (`supabase/auth#1308`, `#2155`).

So the app sends Apple's `authorizationCode` — a distinct artifact from the
identity token — to this server, which exchanges it with Apple for a refresh
token and stores it under the D4 custody model: encrypted, deny-all RLS,
service-role accessor only.

The timing is the whole point. The code is **single-use and expires in about five
minutes**, so it can only be captured during sign-in. Ship onboarding without
this and every user who signs up before it lands has no stored grant and can
never be properly revoked — recovering means forcing them all to re-authenticate.
This is a requirement whose entire payoff lands in a different change, and that
is not a reason to defer it.

Consequences accepted: a second long-lived credential at rest; Apple client
secret generation, which is an ES256 JWT signed with a key from Apple that
expires every six months and needs its own rotation; and a narrow contradiction
of D2 as originally written.

*Alternative considered:* skipping revocation and accepting the review risk.
Rejected — it is a stated App Review requirement, and discovering the problem at
submission is the worst possible moment, because by then the authorization codes
have all been discarded.

*Alternative considered:* dropping Sign in with Apple and offering Google only.
Rejected — offering third-party sign-in without an equivalent privacy-preserving
option is itself a review risk.

### D14. The contract is a published artifact, because the client is a separate repository

The iOS app lives in its own repository. A monorepo would buy atomic
cross-cutting changes and shared types, and neither is actually available: App
Review takes days, so server and client can never ship together, and Swift and
TypeScript cannot share types without generation — which works identically across
two repositories.

What the split does require is a contract that is generated rather than
described. `fastify-type-provider-zod` already makes the Zod schemas the OpenAPI
document, and Apple's `swift-openapi-generator` consumes it as an SPM plugin, so
the DTO layer costs a build step in the client repo and nothing here.

Published on tag from this repository, which is already the source of truth:

```
  contract/
    openapi.json          generated, already exists
    money-vectors.json    decimal strings → cents, including the rounding cases
    signing-vectors.json  added by add-rule-triggers
```

`money-vectors.json` exists because OpenAPI types money as `string` and nothing
in a generated Swift client prevents `Double(amountString)` — which reintroduces,
on the side that displays the number a user is approving, exactly the float
problem this codebase went to some effort to remove.

*Alternative considered:* a third `budj-contract` repository. Rejected as
overhead for two consumers; revisit if a third appears.

### D15. Clients in the wild must be gateable, including partially

A deployed server updates in seconds. A shipped iOS build persists for as long as
users decline to update, and cannot be recalled — an expedited release still
requires each user to act.

For an application that moves money that is a real operational risk, so the
server enforces a **minimum supported build**, and can independently disable
money-moving operations for a known-bad range while leaving the rest of the app
usable. Killing an entire client version because its amount digest is wrong is a
worse outcome than refusing only the operations that depend on it.

The client sends its build identifier on every request; the gate lives beside the
subscription check, which already performs a lookup. Configuration is
environment-driven rather than a table — this must be changeable during an
incident without a migration.

Built now because it cannot be built in a hurry: the version that needs blocking
is, by definition, already shipped, and a client that does not send its build
identifier cannot be gated at all.

### D16. Currency defaults become NZD

`accounts.types.ts`, the `accounts` table default, and
`transactionCandidateSchema` all default to `GBP`. Akahu is New Zealand-only.
Trivial now, irritating once rows exist.

## Risks / Trade-offs

**Tenancy over Akahu data has one guard, not two.** Postgres cannot check that
`acc_x` belongs to this user. → D6 restores a local check under RLS for anything
referenced by a rule; every Akahu call takes an explicit `userId` resolved from
the verified JWT, never from a request body.

**The encryption key is a single point of failure.** Losing
`AKAHU_TOKEN_ENC_KEY` orphans every stored token and forces every user to
reconnect their bank. → Key stored in Render's secret store, documented in the
runbook, and the token column carries a key-version prefix so rotation is
possible without a flag day.

**~~Apple may require IAP rather than Stripe.~~ Resolved: IAP is required.** The
billing module is StoreKit 2 throughout (D8). The residual risk is the 15–30%
commission on every subscription, which is a business input rather than an
engineering one.

**You cannot cancel, pause, or refund an Apple subscription from the server.**
There is no such endpoint; only the user can, in App Store settings. This is not
merely inconvenient — it changes account deletion, because deleting an account
does not stop the charging. → Handled in `add-account-deletion`; noted here
because it is a property of D8, not of that change.

**Duplicate identities.** The same person signing in with Google and later Apple
produces two `auth.users`, two subscriptions, two Akahu connections and two Akahu
bills. Email matching does not help, because of the private relay (D3). → Not
solved in this change; see Open Questions. The cost of deciding late is real
money, so it should not be deferred far.

**The migrations in this repository have never been applied to a running
database.** Every RLS policy, the `handle_new_user` trigger, and the assumption
that PostgREST returns `numeric` as a string are unverified. → This change
introduces the integration suite against a local `supabase start` stack. That is
a prerequisite task, not a nice-to-have.

**Two bank redirects across the product's lifetime.** Read consent here, payment
consent at first money-moving rule. → Accepted deliberately: it front-loads less,
puts the frightening bank screen next to a concrete rule, and per the Akahu
findings a single combined request is not possible anyway.

## Migration Plan

The destructive rewrite of `accounts` is free: the migrations have never run
against any database, so there is no production data and no backfill. Rather than
layering a second migration on top, **`00000000000001_init.sql` is edited in
place** and the new tables are added to it. This is the last change for which
that is legitimate; after this, migrations are append-only.

1. Spike: App Store IAP determination (blocking on the billing work only).
2. Local Supabase stack running, `pnpm db:reset`, first integration test
   asserting a sign-up creates a profile and RLS blocks cross-user reads.
3. Schema: rewrite `accounts`, add `akahu_tokens`, `akahu_connections`,
   `billing_subscriptions`, `device_registrations`, NZD defaults, `updated_at`
   triggers and RLS policies for each. `pnpm types:generate`.
4. `billing` module, behind a plan catalogue in code. Stripe webhook first, so
   state can be observed before it can be created.
5. `bank-connections` module. Token custody and the encryption helper before the
   OAuth flow, so nothing transiently writes a plaintext token.
6. `devices` and `onboarding` modules — both small, both dependent on the above.
7. `accounts` module rewritten to serve the projection read-only.
8. `CLAUDE.md` updated with D5, D6 and the new module list.

Rollback is deleting the change: no consumer exists yet, and the iOS app does not
ship against this until it is complete.

## Open Questions

1. **Apple IAP or Stripe?** Blocking for the billing module. Everything else can
   proceed.
2. **Identity linking policy** — block a second provider, link it, or accept
   duplicates? Affects the sign-in spec and has a direct Akahu cost.
3. ~~Is Akahu's webhook subscription per app or per user?~~ **Resolved: per
   user**, created after token exchange. It is nonetheless deferred to
   `add-rule-triggers` along with the handler, because subscribing before an
   endpoint exists means Akahu posts to a 404 and may disable the endpoint after
   repeated failures. That change carries a backfill for users onboarded in
   between.
4. **Key rotation procedure** for `AKAHU_TOKEN_ENC_KEY` — the versioned prefix
   makes it possible, but nobody has written the runbook.
5. **What does the app show a user whose connection has broken?** Akahu
   connections can require re-authorisation. This change stores
   `disconnected_at`, but the recovery flow is unspecified.
