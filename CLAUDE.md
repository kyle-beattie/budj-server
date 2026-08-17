# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

This project uses **pnpm** — never `npm`. `packageManager` is pinned in
`package.json`; `corepack enable` selects the right version.

```bash
pnpm dev              # tsx watch, pretty logs, http://localhost:3000 (+ /docs)
pnpm build            # tsc -> dist/
pnpm typecheck        # tsc --noEmit
pnpm test             # vitest run
pnpm db:start         # local Supabase stack (needs Docker)
pnpm db:reset         # recreate local DB, replay supabase/migrations
pnpm db:diff <name>   # write a migration from local schema drift
pnpm db:push          # apply migrations to the linked project
pnpm types:generate   # regenerate src/supabase/database.types.ts
pnpm contract:emit    # write contract/ for the iOS repo (generated, not edited)
```

Single test file or single case:

```bash
pnpm vitest run test/rules.engine.test.ts
pnpm vitest run -t 'halts on stopProcessing'
```

`pnpm types:generate` targets the **linked remote** project. For a local stack
use `pnpm types:generate:local` — the `--linked` form cannot read it.

**Tests require a `.env`.** `src/config/env.ts` validates `process.env` at
*import* time and throws, so **any** missing required variable fails the suite at
module load with a confusing stack rather than a readable assertion. Copy
`.env.example` first — placeholder values are fine, and a clean checkout passes
`pnpm test` with them unchanged (CI does exactly that). No unit or wiring test
makes a network call; the integration suite skips itself without a local stack.

## Architecture

Fastify 5 + TypeScript (ESM, `NodeNext` — relative imports need the `.js`
extension). Render runs this Node service; Supabase provides Postgres,
PostgREST and the auth server. **There is no Postgres connection and no ORM** —
all data access is PostgREST via `@supabase/supabase-js`.

### The three Supabase clients

`src/supabase/client.ts` — picking the wrong one is the most consequential
mistake available in this codebase.

| Factory                       | Key          | Use for                                     |
| ----------------------------- | ------------ | ------------------------------------------- |
| `createAnonClient()`          | anon         | JWT verification, the auth proxy            |
| `createUserClient(token)`     | anon + JWT   | **all request-scoped data access**          |
| `createServiceClient()`       | service role | admin only — currently just token revocation |

The service-role client **bypasses RLS entirely**. Never use it to serve a
normal request; that silently disables the database's half of the tenancy
guarantee. The anon client is subject to RLS as an unauthenticated user, so it
must never read application tables either.

**The service-role exceptions are a closed list.** Each one is narrow, keyed by
a `userId` resolved from the verified JWT, and returns a credential or nothing —
never a database row to a caller. Adding a fourth needs the same justification
written down, or the rule erodes within a month.

1. Token revocation (`AuthService.signOut`) — a stateless client holds no
   session to sign out of.
2. `AppleGrantRepository` — `apple_grants` carries deny-all RLS and is withheld
   from `authenticated`, so nothing else can write it.
3. **App Store Server Notifications** (`billing.routes.ts`) — structurally
   different from the others: Apple holds no Supabase session, so the request is
   authenticated by a JWS certificate chain rather than a JWT, and `requireAuth`
   cannot apply. Not user-initiated, returns nothing to a caller.
4. **Purchase submission** (`POST /api/billing/transaction`) — the caller is
   authenticated, but `billing_subscriptions` is select-only for its owner *so
   that* a user cannot grant themselves a plan. The user id comes from the
   verified JWT; only the write bypasses RLS.
5. `AkahuTokenRepository.getAkahuToken(userId)` — a bearer credential for
   someone's bank. `userId` must come from the verified JWT, never from a
   request body; that is the constraint keeping this narrow.

### Tenancy is enforced twice, on purpose

`requireAuth` puts a `createUserClient(token)` on `request.supabase`, so
PostgREST sees the caller's JWT, `auth.uid()` resolves, and the RLS policies in
`supabase/migrations/` apply. Repositories *also* filter `.eq('user_id', userId)`
on every query. This redundancy is deliberate — don't remove either half as
"dead code". Policies live with the table that owns them in the migration.

### Module registry

`src/modules/index.ts` is the single place that knows which modules exist and
where they mount. Each is registered in its own encapsulated Fastify scope.

| Module             | Mount                   | Guards                          |
| ------------------ | ----------------------- | ------------------------------- |
| `auth`             | `/api/auth`             | mixed — see below               |
| `user`             | `/api/users`            | auth                            |
| `accounts`         | `/api/accounts`         | auth (read-only projection)     |
| `rules`            | `/api/rules`            | auth + subscription             |
| `billing`          | `/api/billing`          | mixed — notifications are open  |
| `bank-connections` | `/api/bank-connections` | auth + subscription             |
| `devices`          | `/api/devices`          | auth + subscription             |
| `onboarding`       | `/api/onboarding`       | auth **only**, deliberately     |

The two "mixed" entries are the ones to read before changing: `auth` is public
except `/me`, `/sign-out`, `/password` and `/apple/grant`; `billing` gates
nothing, because the App Store notification endpoint cannot hold a JWT and the
catalogue, subscription read and purchase submission must all be reachable
before a user has paid.

Adding a module:

1. New `supabase/migrations/*.sql` with the table, RLS policies, `updated_at`
   trigger — **and a `grant` for the roles that need it**, because the initial
   migration's blanket grant was a snapshot and does not cover new tables.
2. `pnpm db:reset` then `pnpm types:generate:local` (`types:generate` targets the
   linked remote project).
3. Create `src/modules/<name>/` and add one line to the registry.
4. Add the routes to `test/app.test.ts`, which asserts every guarded route
   rejects an anonymous caller before validation.

### Layering inside a domain module

`rules` is the reference implementation for a user-owned resource; copy it.
`accounts` is **not** a template — it is a read-only projection of what Akahu
reports, with no create, update or delete route, because an account is a fact a
bank reports rather than a record a user makes.

`*.types.ts` (Zod DTOs) → `*.repository.ts` (PostgREST queries only) →
`*.service.ts` (business rules, throws `AppError`) → `*.routes.ts` (thin
handlers) → `index.ts` (public surface).

Table structure is **not** in the module — Postgres owns it and
`src/supabase/database.types.ts` is generated from it. Never hand-edit that file.

Services take a `userId` argument rather than a `FastifyRequest`, which keeps
them testable and unable to act on the wrong user.

**Where a decision is hard to get right, it is extracted as a pure function with
no I/O and no clock**, so the whole table can be tested directly rather than
through HTTP and a database:

- `rules/rules.engine.ts` — the matcher
- `billing/entitlement.ts` — what each App Store notification means
- `bank-connections/account-mapping.ts` — Akahu's vocabulary to ours
- `plugins/client-version.ts` — `evaluateClientBuild`, `isMoneyMovementBlocked`
- `lib/money.ts` — decimal strings to cents

### Environment

`src/config/env.ts` validates at *import* and throws, so a missing variable is a
startup failure with a readable message rather than a 500 later.
`.env.example` carries a placeholder for every required variable and is what CI
copies; a clean checkout passes `pnpm test` with it unchanged.

Two rules that are enforced rather than documented: production refuses to boot
without `MIN_SUPPORTED_BUILD`, and `TOKEN_ENC_KEY` is parsed at import so a
malformed key fails at startup rather than the first time someone connects a
bank.

**`docs/key-runbook.md` is the file to read before touching any secret.** It
covers what each key protects, what is unrecoverable if it is lost, and how to
rotate it — including the Sign in with Apple key, which **expires every six
months and fails silently**, because a failed code exchange is deliberately
swallowed so it cannot break sign-in.

### Things that will bite you

**Services are built per request, never at registration.** The Supabase client
carries the caller's token, so a module-level `new AccountsService(...)` would
pin every request to whoever happened to call first. Each routes file has a
`serviceFor(request)` helper — use it.

**`requireAuth` is an `onRequest` hook, not `preHandler`.** Fastify validates the
body before `preHandler`, so guarding there makes an anonymous `POST` return 400
and leak the request schema instead of 401. `test/app.test.ts` asserts 401 on
every guarded route, and asserts 400 on the *public* auth routes to prove they
stayed unguarded — don't "fix" either by moving the hook.

**Provider credentials at rest go through `src/lib/token-crypto.ts`.** Never
store a raw Akahu or Apple token, even transiently. Ciphertext is
`v1:<base64url>` and the version prefix is what makes rotation possible without
a flag day — put the new key first in `TOKEN_ENC_KEY` and leave the old one
until nothing references it. The tables holding these (`akahu_tokens`,
`apple_grants`) have RLS enabled with **no policies** and are withheld from
`authenticated` in the grants block. Both facts are deliberate; neither is an
oversight to fix.

**Never write to `auth.users`.** Supabase owns it. `public.profiles` is the
application-owned record, created by the `handle_new_user` trigger on signup.
Email and password changes go through the auth module (`POST /api/auth/password`),
never a direct table write. The profile's `email` is read from the verified JWT
claims rather than stored, so the two cannot drift.

**OAuth never touches this server.** The iOS app sends its Apple/Google identity
token straight to Supabase via `signInWithIdToken`; `requireAuth` then covers
those users unchanged. `POST /api/auth/apple/grant` is the sole provider
endpoint and it takes an authorization *code*, not an identity token — see
`docs/ios-integration.md` for why, and for the two one-shot values the app must
capture at sign-in or lose permanently. `test/app.test.ts` asserts no
identity-token route exists; don't add one.

**`src/types/fastify.d.ts` must not be imported at runtime.** It's picked up by
tsconfig's `include`; an `import './types/fastify.js'` resolves to nothing at
runtime and crashes on boot.

**Collection routes register at `''`, not `'/'`.** `'/'` under a prefix produces
`/api/accounts/` in the router and the OpenAPI document.
`routerOptions.ignoreTrailingSlash` in `app.ts` makes the trailing-slash form
still resolve.

**RLS is not a grant.** A policy decides *which rows* a role may touch; it does
not give the role access to the table. Without a table-level `grant`, PostgREST
answers `42501 permission denied for table X` before consulting any policy — so
a table can have a full set of correct-looking policies and be completely
unreachable. Supabase's default privileges do **not** cover this; the `grants`
block in the migration is written out by hand and every new table must be added
to it. `anon` is deliberately absent from it, and `akahu_tokens` / `apple_grants`
are withheld from `authenticated` too, so a mistakenly added policy still would
not expose them.

**Revoking Akahu access has a fixed order: revoke with Akahu, *then* delete the
stored token, then mark connections disconnected.** The ciphertext is the only
thing that can authenticate the revocation, so deleting it first leaves the
connection live and Akahu billing for a user who has stopped paying, with
nothing left to stop it — permanently. When Akahu fails, `AkahuBankAccessRevoker`
deliberately **keeps** the credential so a retry is possible, while still
marking local state disconnected.

**Akahu facts that contradict the obvious guess.** Authorisation goes through
`POST /v1/par` and Akahu returns the URL — building an `oauth.akahu.nz` URL by
hand puts the scope set in a dashboard rather than in this repo, and makes D7
unassertable. `GET /v1/connections` is the *institution catalogue*, not a user's
connections; those come from the nested `connection` on each account. User-scoped
reads need `Authorization: Bearer <user token>` **and** `X-Akahu-Id: <app token>`
together. `POST /v1/token` reports failure in `error`, every other endpoint uses
`message`, and a 200 can still carry `success: false`.

**Every client request must carry `x-client-build`, and a missing one is
unsupported rather than exempt.** A client that cannot be identified cannot be
gated, so absence is refused with `426 CLIENT_UPDATE_REQUIRED`. Webhooks, health
and docs are exempt by prefix — they are not client requests. The gate is inert
when `MIN_SUPPORTED_BUILD` is unset, and `env.ts` refuses to boot in production
without it, because a deployment with no minimum has no version gate at all and
the gap stays invisible until a bad build needs stopping.
`requireMoneyMovementAllowed` is separate and unused so far: nothing initiates a
payment yet, but `add-rule-triggers` inherits a working gate rather than building
one during an incident.

**Four refusals, four different screens.** 401 sign in · 402 subscribe · 403
upgrade plan · 426 update the app. Keep them distinct — collapsing any two sends
someone to a screen that cannot fix their problem.

**Money never touches a float.** `src/lib/money.ts` parses decimal strings to
cents by string manipulation, and rejects three decimal places rather than
rounding. `contract/money-vectors.json` is generated from it and asserted against
it in CI, because the iOS client is generated from an OpenAPI document that types
money as `string` and nothing there stops `Double(amountString)`.

**`requireSubscription` gates everything past identity, and must stay off four
things.** There is no free tier, so it is a hard boundary rather than a feature
flag: `onRequest`, always after `requireAuth`, answering 402
`SUBSCRIPTION_REQUIRED` — a distinct code from 401 and 403 because the app sends
those three to different screens. It must **not** guard onboarding status (the
unpaid user is exactly who needs to be told billing is their next step —
guarding it deadlocks the app at screen two), the plan catalogue, purchase
submission, or auth. `test/integration/billing.gate.test.ts` asserts all of that.

**Never widen Apple JWS verification.** `src/modules/billing/apple-jws.ts` is
the only thing between the internet and a free subscription. The trust anchor is
Apple Root CA - G3, pinned as bytes in `apple-root-ca.ts` and compared with
`Buffer.equals` — **not** by subject name, because a self-signed certificate
carrying Apple's exact distinguished name takes one `openssl` command to make
(there is one in the test fixtures). The `rootPem` option exists only so the
tests can exercise the accept path; production never passes it.

**`grant … on all tables in schema public` is a snapshot, not a rule.** It
covers the tables that existed when it ran and nothing created afterwards, so
**every new migration must grant on its own tables**. With RLS enabled and no
policies the symptom is `42501 permission denied`, which reads like an RLS
problem and is not one. `00000000000003` is the worked example.

**A migration must not be named `*_init.sql`.** The Supabase CLI reserves it:
`db reset` prints a one-line `Skipping migration ...` notice, applies nothing,
and exits 0. The initial schema is `00000000000001_initial_schema.sql` for this
reason.

**Money is `numeric(14,2)` in Postgres and a decimal string everywhere else** —
PostgREST returns it as a string and it stays one through DTOs and JSON. Never a
float.

**`rules.conditions` / `rules.actions` are jsonb**, so PostgREST types them as
`Json`. `rules.service.ts` asserts them back to the Zod-inferred types on read;
that's safe because Zod validated them on write and nothing else writes the
column.

### Errors and validation

`src/supabase/errors.ts` maps `PostgrestError` and `AuthError` onto the
`AppError` hierarchy — including RLS rejections (`42501`), which become 404 so a
caller can't confirm someone else's row exists. Services throw; the handler in
`src/plugins/error-handler.ts` is the only code that writes an error response.
Every failure is `{ error: { code, message, details? } }`. Note that the
Zod/serialization type guards in that file erase the declared error type, so the
tail of the handler re-asserts `FastifyError`.

Zod schemas drive request validation, response serialization *and* the OpenAPI
document (`fastify-type-provider-zod`). A response that doesn't match its declared
schema becomes a 500 rather than leaking.

### Testing

`test/app.test.ts` builds the entire app and asserts modules mount where the
registry says, guards reject anonymous callers before validation, public auth
routes reach validation, and OpenAPI generates. No Supabase project needed — a
missing token is rejected without any network call. It proves wiring, not
behaviour.

`test/integration/` runs against a local `supabase start` stack and proves what
the wiring test cannot: that the migration applies, that the RLS policies do what
their names claim, that `handle_new_user` fires. `test/integration/harness.ts`
builds the clients and skips the whole suite when no stack is up, so `pnpm test`
still passes without Docker.

It **refuses to run against a non-loopback `SUPABASE_URL`** — these tests create
and delete users, and there is deliberately no override. A hosted URL reads as
"stack absent" and skips.

Bring it up with `pnpm db:start && pnpm db:reset`. The local stack's keys are the
ones `supabase start` prints; placeholder values in `.env` fail with
`Expected 3 parts in JWT`.

**External providers are stubbed, never called.** Apple and Akahu are exercised
against fake `fetch` implementations and, for Apple's JWS, a throwaway
certificate chain in `test/fixtures/`. That verifies *our* request shapes,
signature handling and error paths — it does not verify that either provider
accepts them. Nothing in this repository has ever talked to the real Akahu API,
and Apple has only been exercised through a pinned root certificate.

The gap that closes it is `docs/storekit-sandbox-testing.md`, which needs a
device and an App Store Connect account.

### Cross-repository contract

The iOS app is a separate repository and cannot be verified against source it
does not have, so the contract is **generated and published** rather than
described: `pnpm contract:emit` writes `contract/`, and `.github/workflows/
release.yml` attaches it to `v*` tags.

`openapi.json` is not committed — it is ~9,700 lines and would swamp the diff of
every schema change. `money-vectors.json` is, and CI fails if regenerating it
produces a diff, because a committed vector file that disagreed with the server
would be believed.

`docs/ios-integration.md` is the prose half: the two one-shot values Apple gives
exactly once, the bank connection flow, the build header, and the four refusals
that lead to four different screens.
