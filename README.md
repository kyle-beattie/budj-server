# budj-server

Budgeting API. Fastify 5 + TypeScript, Postgres via Drizzle, authentication by
[better-auth](https://better-auth.com), deployed to Render.

## Quick start

```bash
cp .env.example .env
# set DATABASE_URL, and generate a secret:
openssl rand -base64 32          # -> BETTER_AUTH_SECRET

pnpm install
pnpm db:migrate                  # apply ./drizzle to your database
pnpm dev                         # http://localhost:3000, docs at /docs
```

This project uses **pnpm** (`packageManager` is pinned in `package.json`; run
`corepack enable` once to have the right version selected automatically).

## Layout

Each area of concern is a directory under `src/modules/`. A module owns its
tables, its validation schemas, its data access and its routes, and exposes them
through `index.ts`. Nothing outside a module reaches into another module's
internals — cross-module use goes through the exported service.

```
src/
├── app.ts                  buildApp() — assembles plugins + modules, no port binding
├── server.ts               entry point: listen + graceful shutdown
│
├── config/
│   ├── env.ts              process.env parsed and validated by Zod; throws on boot
│   └── index.ts            typed config object + route prefixes
│
├── db/
│   ├── index.ts            pg Pool + Drizzle client factory
│   ├── schema.ts           re-exports every module's tables (what drizzle-kit reads)
│   └── migrate.ts          runtime migrator; used by Render's pre-deploy step
│
├── lib/                    shared primitives, no domain knowledge
│   ├── errors.ts           AppError hierarchy (NotFound, Conflict, …)
│   ├── http.ts             error envelope + shared param schemas
│   └── pagination.ts       list query params and response envelope
│
├── plugins/                cross-cutting Fastify plugins (all fastify-plugin wrapped)
│   ├── db.ts               decorates fastify.db, owns the pool lifecycle
│   ├── error-handler.ts    the only place errors become HTTP responses
│   ├── health.ts           /healthz (liveness) and /readyz (checks Postgres)
│   ├── security.ts         CORS, helmet, rate limiting
│   └── swagger.ts          OpenAPI from the Zod schemas; /docs, non-production only
│
├── modules/
│   ├── index.ts            the registry: which modules exist, at which prefix
│   │
│   ├── auth/               → /api/auth
│   │   ├── auth.config.ts    betterAuth() configuration
│   │   ├── auth.schema.ts    the four tables better-auth owns
│   │   ├── auth.plugin.ts    fastify.auth + requireAuth / optionalAuth guards
│   │   ├── auth.routes.ts    forwards /api/auth/* to better-auth's handler
│   │   └── auth.cli.ts       entry point for `pnpm auth:generate`
│   │
│   ├── user/              → /api/users     profile view of the auth user
│   ├── accounts/          → /api/accounts  budget accounts
│   └── rules/             → /api/rules     transaction classification rules
│
└── types/fastify.d.ts      declaration merging for the decorators above
```

### The shape of a domain module

`accounts` and `rules` both follow the same four-layer split. Copy either one
when adding a module:

| File               | Responsibility                                                       |
| ------------------ | -------------------------------------------------------------------- |
| `*.schema.ts`      | Drizzle table definition. The only place SQL structure is described.  |
| `*.types.ts`       | Zod schemas for request/response bodies, plus the inferred TS types.  |
| `*.repository.ts`  | Queries. No business rules, no HTTP. Every query scoped by `userId`.  |
| `*.service.ts`     | Business rules. Takes a `userId`, throws `AppError`s, returns DTOs.   |
| `*.routes.ts`      | Fastify plugin: schemas, guards, and thin handlers that call service. |
| `index.ts`         | The module's public surface.                                         |

`rules` adds `rules.engine.ts` — the matching logic, kept pure so it is testable
without a database.

### Adding a module

1. `mkdir src/modules/<name>` and create the files above.
2. Re-export the tables from `src/db/schema.ts`.
3. Add one line to the registry in `src/modules/index.ts`.
4. `pnpm db:generate` to produce the migration.

## Authentication

better-auth owns every credential and session concern. Nothing in this codebase
hashes a password or mints a token by hand.

- `/api/auth/*` is forwarded verbatim to better-auth's handler: `sign-up/email`,
  `sign-in/email`, `sign-out`, `get-session`, `change-password`, `change-email`,
  `forget-password`, OAuth callbacks, and so on.
- Sessions ride an httpOnly cookie. Browser clients must send credentials, and
  the origin must be listed in `CORS_ORIGINS`.
- Guard a route with `fastify.requireAuth`, then read `request.auth.user.id`.
  It is an `onRequest` hook, so it runs *before* schema validation — an
  anonymous caller gets a 401 rather than a 400 that leaks the body schema.

```ts
fastify.addHook('onRequest', fastify.requireAuth); // whole module
// or per route:  { onRequest: [fastify.requireAuth] }
```

Adding a better-auth plugin (2FA, organisations, magic links) changes its
tables. Regenerate and diff:

```bash
pnpm auth:generate     # writes a reference schema from your config
# reconcile src/modules/auth/auth.schema.ts against it, then:
pnpm db:generate
```

The auth tables are named `auth_user`, `auth_session`, `auth_account` and
`auth_verification`. The `auth_` prefix keeps `auth_account` (an OAuth
credential) distinct from `accounts` (a budget account), and avoids a table
literally called `user`, which is reserved in Postgres. The *exported Drizzle
keys* stay `user` / `session` / `account` / `verification` because the
better-auth adapter looks them up by name — don't rename those.

## Conventions

- **Money** is `numeric(14,2)` in Postgres and a decimal *string* everywhere
  else. It never becomes a float.
- **Errors**: services throw from `lib/errors.ts`. The handler in
  `plugins/error-handler.ts` is the only code that writes an error response.
  Every failure returns `{ error: { code, message, details? } }`.
- **Validation**: Zod schemas drive request validation, response serialization
  *and* the OpenAPI document. A response that doesn't match its schema is a 500,
  not a silent leak.
- **Tenancy**: repositories take `userId` on every method. A query without it
  cannot compile.

## Scripts

| Command                   | Does                                               |
| ------------------------- | -------------------------------------------------- |
| `pnpm dev`                | tsx watch, pretty logs                             |
| `pnpm build`              | `tsc` to `dist/`                                   |
| `pnpm start`              | run the build                                      |
| `pnpm typecheck`          | `tsc --noEmit`                                     |
| `pnpm test`               | vitest                                             |
| `pnpm db:generate`        | diff the schema, write a migration to `drizzle/`   |
| `pnpm db:migrate`         | apply pending migrations (local)                   |
| `pnpm db:migrate:prod`    | apply pending migrations from `dist/` (Render)     |
| `pnpm db:studio`          | Drizzle Studio                                     |
| `pnpm auth:generate`      | emit better-auth's reference schema for comparison |

## Tests

`test/app.test.ts` is a wiring test — it builds the whole app against a stub
database and asserts that every module mounts where the registry says, that
guards reject anonymous callers, and that the OpenAPI document generates. It
needs no Postgres.

`test/rules.engine.test.ts` covers the rule matcher directly.

Behaviour that genuinely touches the database belongs in an integration suite
pointed at a real `DATABASE_URL`; there isn't one yet.

## Deploying to Render

`render.yaml` is a blueprint describing the web service and a Postgres instance.
Point Render at the repo and it provisions both.

- `buildCommand` compiles to `dist/`; `preDeployCommand` runs migrations before
  traffic switches over.
- `DATABASE_URL` is wired from the database automatically. Render's *internal*
  connection string doesn't use TLS, hence `DATABASE_SSL=false`. Set it to
  `true` if you ever connect over the external URL.
- `BETTER_AUTH_SECRET` is generated by Render on first deploy.
- **`BETTER_AUTH_URL` must match the service's real public URL** — the
  placeholder in `render.yaml` assumes `budj-server.onrender.com`. Auth
  callbacks are rejected if it's wrong.
- `CORS_ORIGINS` is marked `sync: false`; set your frontend origin in the
  dashboard.
- `/docs` is disabled when `NODE_ENV=production`.
