# Key runbook

Four secrets in this system will, if mishandled, break something that cannot be
fixed by redeploying. This is what each one does, what happens when it is lost,
and how to rotate it.

Read the summary, then the section for whichever key you are touching.

| Key | Lost means | Expires | Rotatable without downtime |
| --- | --- | --- | --- |
| `TOKEN_ENC_KEY` | Every user reconnects their bank; Apple grants unrecoverable | Never | **Yes** — version prefix |
| Sign in with Apple `.p8` | New sign-ups cannot be revoked at deletion | **6 months** | Yes |
| App Store Connect `.p8` | Server API calls fail; notifications unaffected | No | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Full database access to whoever holds it | No | Yes, via Supabase |

All of them live in **Render's secret store**. None belongs in this repository,
in `.env.example`, or in a commit message.

---

## `TOKEN_ENC_KEY`

**The single most damaging key to lose.**

### What it protects

Every long-lived provider credential at rest:

- the Akahu user access token — a bearer credential for someone's bank
- Apple's refresh token — the only means of revoking a user with Apple at
  account deletion

Both live in tables with RLS enabled and no policies, so the database is one
lock and this key is the second. A database dump alone does not yield bank
access for anyone.

### If it is lost

Nothing decrypts. Concretely:

- **Every connected user must reconnect their bank.** There is no recovery path
  — the ciphertext is unreadable and Akahu will not reissue a token you cannot
  present.
- **Every Apple grant is unrecoverable**, and those grants can never be
  recaptured: Apple's authorization code is single-use and issued only at
  sign-in. Every affected user would have to sign out and back in, and until
  they do, their account cannot be properly deleted.
- Akahu keeps billing for connections you can no longer revoke, because
  revoking requires the token.

The second point is the one that does not heal on its own. Treat this key as
unrecoverable-if-lost, not merely inconvenient.

### Format

```
TOKEN_ENC_KEY=v1:<base64 of 32 random bytes>
```

Generate one with:

```bash
node -e "console.log('v1:' + require('crypto').randomBytes(32).toString('base64'))"
```

### Rotating it

This is why the ciphertext carries a version prefix — rotation is a config
change, not a flag day, and there is no window where half the rows are
unreadable.

1. Generate a new key and **prepend** it, keeping the old one:

   ```
   TOKEN_ENC_KEY=v2:<new>,v1:<old>
   ```

   The first entry encrypts new values; every listed version still decrypts.
   Deploy. Nothing breaks and nothing needs migrating.

2. Let existing rows re-encrypt naturally, or force it: any user who reconnects
   a bank or signs in with Apple again gets written under `v2`.

3. **Only when nothing references `v1`** — verify by decrypting every stored
   ciphertext, or simply wait out a full re-authorisation cycle — drop it:

   ```
   TOKEN_ENC_KEY=v2:<new>
   ```

   Removing `v1` too early is indistinguishable from losing it. A stored value
   under a version the keyring no longer holds throws rather than returning
   null, deliberately: it is a configuration emergency, not a per-record
   problem to swallow.

### Why it is not called `AKAHU_TOKEN_ENC_KEY`

The spec originally named it that. It was renamed because it also protects
Apple's refresh tokens, and a key named for Akahu invites someone to rotate
"the Akahu key" during an incident without realising every Apple grant went with
it. The name is part of the safety.

---

## Sign in with Apple key (`APPLE_PRIVATE_KEY`)

**This one expires on its own, and fails quietly when it does.**

### What it does

Signs the ES256 client secret used to exchange Apple's authorization code for a
refresh token. Used by `POST /api/auth/apple/grant`, and nothing else.

### Expiry — the part that will catch someone

Apple's Sign in with Apple keys are valid for **six months**. When one lapses,
`POST /api/auth/apple/grant` starts failing, and **the failure is deliberately
swallowed**: the endpoint answers `200 {"stored": false, "reason": "..."}`
because a failed exchange must not break sign-in.

So the symptom is not an outage. It is a `logger.warn` per sign-up and a slowly
growing population of users who cannot be revoked with Apple at deletion — and
whose grants cannot be recaptured, because the authorization code was
single-use.

**Set a calendar reminder for five months from issue.** There is no automatic
alert for this; add one to whatever alerting exists by grepping for the warning
`Apple authorization code exchange failed`.

### Rotating it

1. Apple Developer → Certificates, Identifiers & Profiles → Keys → new key with
   *Sign in with Apple* enabled. Note the Key ID; the `.p8` downloads **once**.
2. Set `APPLE_KEY_ID` and `APPLE_PRIVATE_KEY` together. Newlines may be written
   as literal `\n`.
3. Deploy. The client secret is minted per request with a 120-day life, so
   nothing is cached and the change takes effect immediately.
4. Revoke the old key in Apple's console.

`APPLE_TEAM_ID` and `APPLE_CLIENT_ID` (the bundle identifier) do not rotate.

---

## App Store Connect key (`APP_STORE_PRIVATE_KEY`)

A **different** key from the one above. Confusing the two costs half a day of
opaque `invalid_client` errors.

### What it does

Authenticates server-to-server calls to the App Store Server API.

**It is not used to verify notifications or transactions.** Those are verified
by a JWS certificate chain to Apple's pinned root (`apple-root-ca.ts`), which
needs no credential at all. So losing this key does not stop entitlement being
recorded — App Store Server Notifications keep working.

### Rotating it

App Store Connect → Users and Access → Integrations → App Store Connect API.
Set `APP_STORE_KEY_ID` and `APP_STORE_PRIVATE_KEY` together. No expiry.

### `APP_STORE_ENVIRONMENT`

Not a key, but it lives here because getting it wrong is a security bug rather
than a nuisance.

`Sandbox` and `Production` issue **overlapping transaction identifiers**, so a
production server accepting sandbox purchases is a free subscription for anyone
with Xcode. The server refuses a transaction whose environment does not match.

Consequence: **this must be flipped to `Production` before release**, and the
symptom of forgetting is that every real purchase is rejected.

---

## `SUPABASE_SERVICE_ROLE_KEY`

Bypasses RLS entirely. Whoever holds it has unrestricted read and write access
to every user's data — including the two credential tables that no other client
can see.

It is used by a **closed list** of five call sites, documented in `CLAUDE.md`.
If you find a sixth, that is the thing to review, not this runbook.

Rotate from the Supabase dashboard (Project Settings → API). Rotating invalidates
the old key immediately, so deploy the new value in the same change.

---

## What is *not* secret

For the avoidance of doubt, since these appear in configuration alongside the
above:

- `SUPABASE_ANON_KEY` — publishable, subject to RLS, ships to clients.
- `AKAHU_APP_TOKEN` — identifies the application, not a user. Useless without
  the app secret or a user token.
- `MIN_SUPPORTED_BUILD`, `BLOCKED_MONEY_BUILDS` — operational settings, and
  deliberately environment-driven so they can change during an incident without
  a migration.

`AKAHU_APP_SECRET` **is** secret: with the app token it can start authorisation
flows in this application's name.
