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
```

Single test file or single case:

```bash
pnpm vitest run test/rules.engine.test.ts
pnpm vitest run -t 'halts on stopProcessing'
```

`pnpm types:generate` targets the **linked remote** project. For a local stack
use `pnpm types:generate:local` — the `--linked` form cannot read it.

**Tests require a `.env`.** `src/config/env.ts` validates `process.env` at *import*
time and throws, so a missing `SUPABASE_URL` / `SUPABASE_ANON_KEY` /
`SUPABASE_SERVICE_ROLE_KEY` / `PUBLIC_URL` fails the suite at module load with a
confusing stack. Copy `.env.example` first — placeholder values are fine, the
tests make no network call.

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
3. `getAkahuToken(userId)` — *pending*, arrives with the bank-connections
   module, same custody model.

### Tenancy is enforced twice, on purpose

`requireAuth` puts a `createUserClient(token)` on `request.supabase`, so
PostgREST sees the caller's JWT, `auth.uid()` resolves, and the RLS policies in
`supabase/migrations/` apply. Repositories *also* filter `.eq('user_id', userId)`
on every query. This redundancy is deliberate — don't remove either half as
"dead code". Policies live with the table that owns them in the migration.

### Module registry

`src/modules/index.ts` is the single place that knows which modules exist and
where they mount. Each is registered in its own encapsulated Fastify scope.

Adding a module: write the table + RLS policies + `updated_at` trigger in a new
`supabase/migrations/*.sql`, `pnpm db:reset`, `pnpm types:generate`, create
`src/modules/<name>/`, then add one line to the registry.

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
them testable and unable to act on the wrong user. `rules` adds
`rules.engine.ts`: the matcher, kept pure (no I/O, no clock) so it tests directly.

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
