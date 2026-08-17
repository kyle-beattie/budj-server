# iOS integration notes

For the Budj iOS repository. This covers sign-in only; billing, bank connections
and the published contract are added as those land.

## Sign-in goes to Supabase, not to this server

For Apple and Google, the app obtains an identity token from the platform SDK
and calls Supabase's `signInWithIdToken` **directly**. This server never sees
that token — it verifies the resulting Supabase JWT like any other request.

There is no `/api/auth/apple/sign-in`, and there will not be one. Email and
password remain available at `POST /api/auth/sign-in` as a fallback.

## Two one-shot values, captured at sign-in or lost forever

Both of the following are available **only during the first sign-in**, and
neither can be recovered afterwards without the user removing Budj from
Settings → Apple ID → Sign in with Apple and starting again. They fail
silently: nothing errors, the user is signed in, and the loss is discovered
months later by someone else.

Treat both as part of the sign-in transaction rather than as follow-up work.

### 1. Apple sends the user's real name exactly once

`ASAuthorizationAppleIDCredential.fullName` is populated on the **first
authorisation ever** for this Apple ID and this app, and is `nil` on every
subsequent sign-in — including after a reinstall, and on other devices.

It must be included in the `signInWithIdToken` call that creates the account:

```swift
try await supabase.auth.signInWithIdToken(
  credentials: .init(
    provider: .apple,
    idToken: idToken,
    // Read from credential.fullName on FIRST authorisation only.
    // Absent here means the profile has an empty display name forever.
    data: ["full_name": .string(formattedName)]
  )
)
```

The server reads `full_name`, then `name`, from the identity claims and
otherwise leaves the display name **empty**. It does not fall back to the email
local part: with Hide My Email that would name people `xyzabc123`, which looks
like a real answer and never gets corrected. An empty name is a prompt the app
can resolve; a relay fragment is not.

If the name is missed, ask the user for it in the app and `PATCH /api/users/me`.

### 2. Apple's authorization code must be POSTed during sign-in

Separate from the identity token, `ASAuthorizationAppleIDCredential` carries an
`authorizationCode`. It is **single-use and expires in about five minutes.**

Send it immediately after `signInWithIdToken` succeeds:

```
POST /api/auth/apple/grant
Authorization: Bearer <supabase access token>

{ "authorizationCode": "c1a2b3..." }
```

```json
{ "stored": true }
```

Always `200`, even on failure (`{ "stored": false, "reason": "invalid_grant" }`).
The user is signed in either way and there is nothing to retry — the code is
spent. **Do not block sign-in on this response**, and do not surface the failure
to the user.

Why it matters: Apple requires apps offering Sign in with Apple to revoke the
user's tokens when their account is deleted. That needs an Apple refresh token,
and Supabase does not expose one for the native flow — `providerRefreshToken` is
`nil`. The server exchanges this code for one and stores it encrypted. Every
user who signs up without it can never be properly revoked, and there is no
backfill: recovering means forcing all of them to re-authenticate.

Send the code on **every** Apple sign-in, not only the first. Re-authorising
replaces the stored grant, which keeps it fresh at no cost.

## Connecting a bank

The server is always in the middle: the app never holds an Akahu token and never
calls Akahu.

1. `POST /api/bank-connections/authorise` → `{ "authorisationUrl": "..." }`
2. Open that URL in an **`ASWebAuthenticationSession`**, with the callback scheme
   matching `AKAHU_REDIRECT_URI`.
3. Akahu redirects back with `code` and `state`. Intercept it in the session —
   do **not** let it reach a browser.
4. `POST /api/bank-connections/callback` with `{ code, state }` **and the user's
   bearer token**.

Step 4 is authenticated on purpose. If the server accepted the redirect directly
on an unauthenticated `GET`, the `state` would be the only thing standing between
a leaked redirect URL and someone else's bank being attached to your account.
Posting it back with the session token binds the exchange twice.

The `state` is **single-use and expires in 15 minutes.** A replayed callback is
refused, so retry by starting again at step 1 rather than reposting.

Two errors the app should handle distinctly:

- `402 SUBSCRIPTION_REQUIRED` — not subscribed. Send them to the purchase screen.
- `403 PLAN_LIMIT_EXCEEDED` — subscribed, but at their plan's connection limit.
  Offer an upgrade; telling them to subscribe is wrong, they already have.
  `details` carries `limit`, `current` and `planCode`.

Accounts arrive through `GET /api/accounts` once the callback succeeds. They are
read-only — there is no create, update or delete — and carry **no balance**,
because none is stored. `paymentFrom` and `paymentTo` are independent: a credit
card commonly has `paymentFrom: true` and `paymentTo: false`, and a rule editor
must respect both.

## Where to resume on launch

`GET /api/onboarding/status` — authenticated, and **not** subscription gated, so
it answers even for a user who has not paid.

```json
{
  "step": "billing" | "bank" | "ready",
  "subscriptionActive": false,
  "planCode": null,
  "bankConnected": false,
  "pushRegistered": false
}
```

Poll it on launch and after completing any step. It is derived from stored facts
on every request, so a purchase confirmed by Apple is visible on the very next
call — there is nothing to advance and nothing that can drift.

`pushRegistered` is **advisory**. `step` reaches `ready` without it, because
declining notifications must not brick the app. Keep prompting anyway: a rule
that cannot notify cannot be approved.

## Registering for push

`POST /api/devices` with `{ deviceId, apnsToken }`. Upserts on the device, so
re-registering when APNs reissues a token is expected — send it on every launch
where the token changes.

Responses never include the APNs token. `DELETE /api/devices/:deviceId` marks the
registration revoked.

**No cryptographic key material is accepted, and none will be.** An earlier
design enrolled a Secure Enclave key so that approving a payment could require a
signature; that was dropped from the product, not deferred. Face ID unlocking the
app is entirely a client concern — hold the Supabase refresh token in the
Keychain behind `kSecAccessControl` and the server neither knows nor cares.

## Sign in with Apple is not optional

Offering Google without an equivalent privacy-preserving option is itself an App
Review risk. Both ship together.
