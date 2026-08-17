# StoreKit sandbox testing

**This procedure has not been run.** It needs Xcode, a device or simulator, and
an App Store Connect account, none of which the server test suite can reach.
Everything below is written to be executed by a person; nothing here is
verified by CI.

It matters more than the usual "nice to have" testing note, because **the paths
it covers are the ones that revoke a user's bank access, and they cannot be
exercised in production.** You cannot refund yourself to see what happens. If
`REFUND` handling is wrong, the first evidence is a customer who kept access
after Apple took the money back, or one who lost it while still paying.

## What to test against

`contract/Budj.storekit` defines both products with the identifiers the server's
catalogue expects:

| Plan    | Product identifier         | Limits                     |
| ------- | -------------------------- | -------------------------- |
| Starter | `com.budj.starter.monthly` | 10 rules, 2 connections    |
| Pro     | `com.budj.pro.monthly`     | 100 rules, 10 connections  |

**These identifiers are load-bearing.** `planByProductId` refuses a product it
does not recognise, so a mismatch between this file and `src/modules/billing/
plans.ts` shows up as a `422` on purchase submission, not as a wrong plan. If
you change one, change both — `test/billing.entitlement.test.ts` asserts the
catalogue, but nothing can assert this file.

The placeholder `_applicationInternalID` and `_developerTeamID` need replacing
with the real values before use.

## Server configuration

Set `APP_STORE_ENVIRONMENT=Sandbox`. The server refuses a transaction whose
environment does not match, deliberately: sandbox and production issue
overlapping identifiers, so a production server accepting sandbox purchases is
a free subscription for anyone with Xcode.

That also means **you must flip this to `Production` before release**, and the
symptom of forgetting is that every real purchase is rejected.

## Local StoreKit testing (Xcode, no App Store Connect)

Fastest loop, and enough for the happy path and the two states that matter.

1. Add `Budj.storekit` to the scheme: *Product → Scheme → Edit Scheme → Run →
   Options → StoreKit Configuration*.
2. Purchase in the app; the app posts the signed transaction to
   `POST /api/billing/transaction`.
3. Confirm `GET /api/billing/subscription` reports `active: true` with the
   expected `planCode`.

**Transactions signed by the local StoreKit test environment are signed by a
local test certificate, not by Apple.** The server's chain verification will
reject them, by design. To exercise the server against local StoreKit you need
either the sandbox environment below, or a temporary trust anchor override —
which must never be committed.

This is a real limitation of the local loop and the reason the sandbox pass
matters.

## Sandbox testing (App Store Connect, signed by Apple)

The only way to exercise the real verification path.

1. Create a Sandbox Apple Account in App Store Connect → Users and Access →
   Sandbox.
2. Sign into it on the device under *Settings → Developer → Sandbox Apple
   Account*. **Not** the main App Store account.
3. Point App Store Server Notifications V2 at the deployed server's
   `/api/billing/apple/notifications` (Sandbox URL field).
4. Sandbox subscriptions renew on an accelerated clock — a month is minutes —
   so renewals and expiry are observable in one sitting.

### The cases worth the trouble

Each of these has a server behaviour that is easy to get wrong and impossible
to verify any other way.

| Case | Do this | Expect |
| --- | --- | --- |
| **Purchase** | Buy Pro | `SUBSCRIBED`, entitlement `active`, correct `planCode` |
| **Renewal** | Wait one accelerated period | `DID_RENEW`, `expiresAt` moves forward |
| **Cancellation** | Turn off auto-renew in Settings | `DID_CHANGE_RENEWAL_STATUS`, and **entitlement stays active** — the user paid for this period |
| **Expiry** | Wait out the cancelled period | `EXPIRED`, entitlement inactive, connections marked disconnected |
| **Refund** | Request one via App Store Connect sandbox tooling | `REFUND`, status `revoked`, connections marked disconnected |
| **Billing failure** | Set the test account's payment to fail | `DID_FAIL_TO_RENEW`; with a grace period entitlement **continues**, then `GRACE_PERIOD_EXPIRED` ends it |
| **Redelivery** | Resend a notification from App Store Connect | Second delivery changes nothing |
| **Resubmission** | Relaunch the app with an unfinished transaction | Same entitlement, no duplicate row |

The cancellation and grace-period rows are the two whose expected behaviour is a
judgement call rather than a mechanical mapping — see `entitlement.ts`. If real
Apple behaviour disagrees with the table above, the code is what should change.

## Known gap while section 6 is outstanding

Expiry and refund currently mark connections and accounts disconnected but do
**not** revoke the token with Akahu — that call needs the Akahu client from the
bank-connections module. Until then, a revoked sandbox user will show
`disconnected_at` set and a warning in the logs, which is the correct behaviour
for this stage rather than a test failure.
