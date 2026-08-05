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
pnpm db:generate      # diff schema -> new migration in drizzle/
pnpm db:migrate       # apply pending migrations (local)
pnpm auth:generate    # emit better-auth's reference schema for comparison
```

Single test file or single case:

```bash
pnpm vitest run test/rules.engine.test.ts
pnpm vitest run -t 'halts on stopProcessing'
```

**Tests require a `.env`.** `src/config/env.ts` validates `process.env` at *import*
time and throws, so a missing `DATABASE_URL` / `BETTER_AUTH_SECRET` /
`BETTER_AUTH_URL` fails the suite at module load with a confusing stack. Copy
`.env.example` first. The tests themselves need no running Postgres.

## Architecture

Fastify 5 + TypeScript (ESM, `NodeNext` — relative imports need the `.js`
extension), Drizzle over Postgres, better-auth for all credentials, Render for
deploy.

### Module registry

`src/modules/index.ts` is the single place that knows which modules exist and
where they mount. Each is registered in its own **encapsulated** Fastify scope,
so hooks and content-type parsers declared inside a module stay inside it — this
is what lets `auth` strip the JSON parser without affecting anything else.

Adding a module: create `src/modules/<name>/`, re-export its tables from
`src/db/schema.ts`, add one line to the registry, `pnpm db:generate`.

### Layering inside a domain module

`accounts` and `rules` are the reference implementations; copy either.

`*.schema.ts` (Drizzle table) → `*.types.ts` (Zod DTOs) → `*.repository.ts`
(queries only) → `*.service.ts` (business rules, throws `AppError`) →
`*.routes.ts` (thin handlers) → `index.ts` (public surface).

Repositories take `userId` on **every** method and scope every query by it —
tenancy is enforced in the data layer, not by remembering to filter in handlers.
Services take a `userId` argument rather than a `FastifyRequest`, which keeps
them testable and unable to act on the wrong user. `rules` adds
`rules.engine.ts`: the matcher, kept pure (no I/O, no clock) so it tests directly.

### Plugin registration order

`buildApp()` in `src/app.ts` registers in a deliberate order:
`error-handler → security → db → auth → health → swagger → modules`. `auth`
depends on `db` (declared via `fastify-plugin`'s `dependencies`), and modules
depend on both decorators existing.

Cross-cutting plugins in `src/plugins/` are `fastify-plugin`-wrapped so their
decorators escape encapsulation. Module route files are **not** wrapped, which is
what keeps their hooks local.

### Things that will bite you

**`requireAuth` is an `onRequest` hook, not `preHandler`.** Fastify validates the
body before `preHandler`, so guarding there makes an anonymous `POST` return 400
and leak the request schema instead of 401. `test/app.test.ts` asserts 401 on
every guarded route — don't "fix" that by moving the hook.

**Auth table names vs Drizzle export keys diverge on purpose.** SQL tables are
`auth_user` / `auth_session` / `auth_account` / `auth_verification`; the exported
Drizzle keys stay `user` / `session` / `account` / `verification` because
better-auth's adapter looks them up by name. Renaming the exports breaks auth
silently. The prefix keeps `auth_account` (OAuth credential) distinct from
`accounts` (budget account) and avoids a table called `user`, reserved in Postgres.

**`/api/auth/*` bypasses Fastify's body parsing.** `auth.routes.ts` calls
`removeAllContentTypeParsers()` in its own scope and forwards raw bytes to
better-auth's fetch handler, then copies the response back. `Set-Cookie` is
extracted with `response.headers.getSetCookie()` — `Headers.forEach` folds
multiple cookies into one comma-joined string that browsers reject.

**Never do auth by hand.** better-auth owns password hashing, sessions and
tokens. Credential changes go through `fastify.auth.api.*` or the forwarded
`/api/auth/*` routes (`change-email`, `change-password`), never a direct write to
`auth_user`. `user.repository.ts` deliberately only writes `name` and `image`.

**`src/types/fastify.d.ts` must not be imported at runtime.** It's picked up by
tsconfig's `include`; an `import './types/fastify.js'` resolves to nothing at
runtime and crashes on boot.

**Collection routes register at `''`, not `'/'`.** `'/'` under a prefix produces
`/api/accounts/` in the router and the OpenAPI document. `routerOptions.ignoreTrailingSlash`
in `app.ts` makes the trailing-slash form still resolve.

**Money is `numeric(14,2)` in Postgres and a decimal string everywhere else** —
DTOs, JSON, Zod schemas. It never becomes a float.

### Errors and validation

Services throw from `src/lib/errors.ts`. `src/plugins/error-handler.ts` is the
only code that writes an error response; every failure is
`{ error: { code, message, details? } }`. Note that the Zod/serialization type
guards in that file erase the declared error type, so the tail of the handler
re-asserts `FastifyError`.

Zod schemas drive request validation, response serialization *and* the OpenAPI
document (`fastify-type-provider-zod`). A response that doesn't match its declared
schema becomes a 500 rather than leaking.

### Testing

`test/app.test.ts` builds the entire app against a stub database via
`buildApp({ database })` and asserts modules mount where the registry says,
guards reject anonymous callers, and OpenAPI generates — no Postgres needed. It
proves wiring, not behaviour.

There is **no integration suite**; nothing has been exercised against a real
database. Behaviour that touches Postgres needs one pointed at a real
`DATABASE_URL`.

### Schema changes

`pnpm db:generate` diffs `src/db/schema.ts` and writes SQL to `drizzle/`.
After adding a better-auth plugin (2FA, organisations, magic links), run
`pnpm auth:generate` — it writes a *reference* schema to compare against;
reconcile `src/modules/auth/auth.schema.ts` by hand (the prefixed table names and
`timestamptz` are intentional deviations), then generate the migration.

On Render, `preDeployCommand` runs `db:migrate:prod`, which uses drizzle-orm's
runtime migrator from `dist/` so it works without devDependencies.
