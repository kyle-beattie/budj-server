## Why

Budj lets a user automate actions on money arriving in their bank account: a rule
fires on an inbound transaction, the user is notified, and on approval money
moves. None of that is reachable today. The server has authentication, an
accounts table modelled as user-entered data, and a rules engine whose actions
annotate transactions that are never stored.

Before any of the automation work is worth doing, a person has to be able to get
from "downloaded the iOS app" to "paying customer with a connected New Zealand
bank account and a registered device". That path crosses two external providers
(Apple, Akahu), is abandonable at every step, and has to be resumable on the
next app launch. It also decides several things that are expensive to change
afterwards — most importantly which Akahu scopes are requested, since widening
consent later means sending the user back through their bank.

This change delivers that path and nothing beyond it. It deliberately stops
short of moving money.

## What Changes

- **Native sign-in with Apple and Google**, with email/password retained as a
  fallback. The iOS app obtains an identity token natively and exchanges it with
  Supabase directly; this server verifies the resulting JWT as it does today.
- **Apple's authorization code is captured and exchanged server-side.** Supabase
  does not expose Apple's provider tokens, and Apple requires them to be revoked
  when an account is deleted. The code is single-use and expires in minutes, so
  it can only be captured at sign-in — months before the deletion flow that needs
  it exists.
- **Plans and subscriptions via StoreKit 2.** App Review requires in-app
  purchase, so Stripe is not used. No free tier — entitlement is a hard gate on
  everything past sign-in. The app purchases and submits a signed transaction;
  App Store Server Notifications keep the cached state honest. Plan entitlements
  live in code, not in a table, and the entitlement record is keyed by *your*
  user id rather than the store's.
- **Akahu bank connection.** A server-mediated OAuth flow requesting account and
  transaction read scopes. The user access token is encrypted and stored in a
  table no user-scoped client can read. Users can connect multiple banks.
- **BREAKING: `accounts` stops being a user-owned table.** Accounts become a
  thin, read-only projection of what Akahu reports. Balances, institution as a
  free-text field, and the user-facing create/update/delete endpoints are
  removed. `POST`, `PATCH` and `DELETE /api/accounts` cease to exist.
- **Device registration.** The iOS app registers an APNs token and a
  Secure Enclave public key. The public key is not used by this change; it is
  the enrolment half of the biometric approval that `add-rule-triggers` needs,
  and it belongs in onboarding because that is when the device is in hand.
- **A derived onboarding status endpoint.** `GET /api/onboarding/status` computes
  the current step from facts already stored. There is no `onboarding_step`
  column to drift out of sync with reality.
- **A published contract artifact.** The iOS app is a separate repository, so the
  generated OpenAPI document and conformance vectors ship as a tagged release
  artifact rather than being described in prose.
- **Client version gating.** The server enforces a minimum supported build and
  can independently disable money-moving operations for a known-bad range. A
  shipped iOS build cannot be recalled, so this has to exist before the first
  release rather than after the first incident.
- **Currency defaults move from GBP to NZD** across schemas and migrations.

Explicitly out of scope, and left to `add-rule-triggers`: Akahu enduring payment
consent, the `payments` scope, transaction webhooks, the pending-execution model,
the approval endpoint, biometric signature verification, and the redesign of
rule actions.

## Capabilities

### New Capabilities

- `identity`: Sign-in with Apple, Google, and email; what this server verifies
  versus what the client does directly against Supabase; profile seeding when the
  provider supplies a private relay address or withholds a name.
- `billing`: Plan catalogue, StoreKit transaction submission and verification,
  cached entitlement state, App Store Server Notification handling, entitlement
  resolution, and the consequences of losing entitlement by any route.
- `bank-connections`: The Akahu authorisation flow, encrypted token custody,
  connection lifecycle across multiple banks, and the account projection that
  replaces the user-owned accounts table.
- `device-registration`: APNs token and Secure Enclave public key registration,
  multiple devices per user, and revocation.
- `onboarding-status`: The derived step machine the iOS app polls on launch to
  decide where to resume.
- `client-compatibility`: The published contract artifact, the build identifier
  every client sends, minimum-supported-build enforcement, and the independent
  kill switch for money-moving operations.

### Modified Capabilities

None. `openspec/specs/` is empty — this is the first change in the project, so
every capability above is introduced rather than amended.

## Impact

**Database.** New migration adding `akahu_tokens`, `akahu_connections`,
`billing_subscriptions`, and `device_registrations`; a destructive rewrite of
`public.accounts`; NZD defaults. `akahu_tokens` is the project's first table with
RLS enabled and **zero policies** — invisible to anon and user clients by design.

**Architecture.** Two documented departures from the rules in `CLAUDE.md`, both
narrow and both requiring that file to be updated in the same change:

1. The service-role client gains a second legitimate use beyond token
   revocation: reading a user's encrypted Akahu credential. Constrained to a
   single function that returns a credential and never returns a row to a caller.
2. The App Store Server Notifications endpoint is unauthenticated in the Supabase
   sense — it is verified by a JWS certificate chain, not by JWT — so it cannot
   use `requireAuth` and must run as service role.

**Modules.** New `billing`, `bank-connections`, `devices`, and `onboarding`
modules, each one line in `src/modules/index.ts`. Substantial rewrite of
`accounts`. Minor additions to `auth`.

**Configuration.** New required environment: App Store Connect API credentials
(issuer id, key id, `.p8` private key, bundle id, app Apple id), Akahu app token
and app secret, the Akahu redirect URI, an encryption key for token custody, and
Apple's Sign in with Apple signing key with its team and key identifiers — a
separate key from the App Store Connect one. `src/config/env.ts` validates at
import, so `.env.example` must grow with them or the test suite fails at module
load.

**External dependencies.** An App Store Server API client (or plain `fetch` plus
JWS verification), an Akahu client, and a JOSE/crypto library for envelope
encryption, x5c chain validation and, later, ES256 verification.

**Commercial.** Apple takes 15–30% of every subscription and owns refunds,
cancellation and dunning. The server cannot cancel, pause or refund a
subscription — there is no such API — which has consequences for account
deletion, handled in `add-account-deletion`.

**Testing.** This change is the first that cannot be proven by `test/app.test.ts`
wiring assertions alone. It needs an integration suite against a local
`supabase start` stack — the migrations in this repository have still never been
applied to a running database.
