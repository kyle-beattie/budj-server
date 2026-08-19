# budj-server

budj app API. Fastify 5 + TypeScript, with Supabase for Postgres and auth,
deployed to Render.

## Quick start

```bash
cp .env.example .env
# fill in SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY

pnpm install
pnpm db:start                    # local Supabase stack (needs Docker)
pnpm db:reset                    # apply supabase/migrations to it
pnpm dev                         # http://localhost:3000, docs at /docs
```

`pnpm db:start` prints the local API URL and keys — paste those into `.env` to
develop against the local stack instead of a hosted project.

This project uses **pnpm** (`packageManager` is pinned in `package.json`; run
`corepack enable` once to have the right version selected automatically).

## How the pieces fit

Render runs this Node service and nothing else. Supabase provides Postgres,
PostgREST and the auth server (GoTrue). This API never opens a Postgres
connection — it talks to PostgREST over HTTP.

```
              ┌─────────────── Render ───────────────┐
  client ────▶│  budj-server (Fastify)               │
              │    • proxies credentials             │
              │    • verifies JWTs locally (JWKS)    │
              │    • builds a per-request client     │
              └───────────────┬──────────────────────┘
                              │  anon key + caller's JWT
              ┌───────────────▼─────── Supabase ─────┐
              │  GoTrue (auth)   PostgREST → Postgres│
              │                        + RLS policies│
              └──────────────────────────────────────┘
```

**Two guards enforce tenancy, deliberately.** Every request builds a Supabase
client carrying the caller's access token, so `auth.uid()` resolves and RLS
policies apply in the database. On top of that, repositories still filter by
`user_id` explicitly. Either alone would do; together, a dropped policy or a
forgotten filter fails closed.

The service-role key bypasses RLS. It is used **only** for token revocation
(`auth.admin.signOut`) — never to serve a normal request.

## Layout

Each area of concern is a directory under `src/modules/`. A module owns its
validation schemas, its data access and its routes, and exposes them through
`index.ts`. Nothing outside a module reaches into another module's internals.

```
src/
├── app.ts                  buildApp() — assembles plugins + modules, no port binding
├── server.ts               entry point: listen + graceful shutdown
│
├── config/
│   ├── env.ts              process.env parsed and validated by Zod; throws on boot
│   └── index.ts            typed config object + route prefixes
│
├── supabase/
│   ├── client.ts           the three client factories (anon / service / per-user)
│   ├── database.types.ts   generated — `pnpm types:generate`
│   ├── errors.ts           PostgrestError + AuthError -> AppError
│   └── index.ts
│
├── lib/                    shared primitives, no domain knowledge
│   ├── errors.ts           AppError hierarchy (NotFound, Conflict, …)
│   ├── http.ts             error envelope + shared param schemas
│   └── pagination.ts       list query params and response envelope
│
├── plugins/                cross-cutting Fastify plugins (all fastify-plugin wrapped)
│   ├── error-handler.ts    the only place errors become HTTP responses
│   ├── health.ts           /healthz (liveness) and /readyz (pings PostgREST)
│   ├── security.ts         CORS, helmet, rate limiting
│   └── swagger.ts          OpenAPI from the Zod schemas; /docs, non-production only
│
├── modules/
│   ├── index.ts            the registry: which modules exist, at which prefix
│   │
│   ├── auth/               → /api/auth
│   │   ├── auth.plugin.ts    Supabase clients, requireAuth / optionalAuth guards
│   │   ├── auth.service.ts   proxy over GoTrue
│   │   ├── auth.routes.ts    sign-up / sign-in / refresh / sign-out / password
│   │   └── auth.types.ts
│   │
│   ├── user/              → /api/users     public.profiles
│   ├── accounts/          → /api/accounts  budget accounts
│   └── rules/             → /api/rules     transaction classification rules
│
└── types/fastify.d.ts      declaration merging for the decorators above

supabase/migrations/        the schema, RLS policies and triggers
```

### The shape of a domain module

`accounts` and `rules` are the reference implementations; copy either.

| File               | Responsibility                                                       |
| ------------------ | -------------------------------------------------------------------- |
| `*.types.ts`       | Zod schemas for request/response bodies, plus the inferred TS types.  |
| `*.repository.ts`  | PostgREST queries. No business rules, no HTTP. Filters by `user_id`.  |
| `*.service.ts`     | Business rules. Takes a `userId`, throws `AppError`s, returns DTOs.   |
| `*.routes.ts`      | Fastify plugin: schemas, guards, and thin handlers that call service. |
| `index.ts`         | The module's public surface.                                         |

Table structure lives in `supabase/migrations/`, not in a module — Postgres is
the source of truth and `database.types.ts` is generated from it.

`rules` adds `rules.engine.ts` — the matching logic, kept pure so it is testable
without a database.

**Services are built per request, not at registration**, because the Supabase
client is bound to the caller's token:

```ts
function serviceFor(request: FastifyRequest): AccountsService {
  return new AccountsService(new AccountsRepository(request.supabase!));
}
```

### Adding a module

1. Write the table, its RLS policies and its `updated_at` trigger in a new
   `supabase/migrations/*.sql`.
2. `pnpm db:reset` (local) or `pnpm db:push` (linked project).
3. `pnpm types:generate` to refresh `database.types.ts`.
4. `mkdir src/modules/<name>` and create the files above.
5. Add one line to the registry in `src/modules/index.ts`.

## Authentication

Supabase Auth owns credentials and tokens. This server proxies the flows so
clients only ever talk to one host; it never hashes a password or mints a token.

| Route                      | Does                                              |
| -------------------------- | ------------------------------------------------- |
| `POST /api/auth/sign-up`   | Create a user. Returns 201; `session` is null when email confirmation is on. |
| `POST /api/auth/sign-in`   | Email + password → access and refresh tokens      |
| `POST /api/auth/refresh`   | Refresh token → a new session                     |
| `POST /api/auth/sign-out`  | Revoke the caller's tokens (global by default)    |
| `POST /api/auth/password/reset` | Send a reset email. Always 202 — never reveals whether an address exists. |
| `POST /api/auth/password`  | Change the signed-in user's password              |
| `GET  /api/auth/me`        | The verified JWT claims                           |

Tokens come back **in the response body**, not as cookies, so native and
server-side clients work without a cookie jar. Clients send
`Authorization: Bearer <accessToken>` on every other route.

Guard a route with `fastify.requireAuth`, then read `request.auth.userId` and
use `request.supabase`. It is an `onRequest` hook, so it runs *before* schema
validation — an anonymous caller gets 401 rather than a 400 that leaks the body
schema.

```ts
fastify.addHook('onRequest', fastify.requireAuth); // whole module
// or per route:  { onRequest: [fastify.requireAuth] }
```

Verification is local: `getClaims()` checks the signature against the project's
JWKS, cached in the client, so a warm process makes no network call per request.

## Conventions

- **Money** is `numeric(14,2)` in Postgres and a decimal *string* everywhere
  else — PostgREST returns it as one. It never becomes a float.
- **Errors**: services throw from `lib/errors.ts`; `supabase/errors.ts` maps
  Postgres and GoTrue failures into that vocabulary.
  `plugins/error-handler.ts` is the only code that writes an error response.
  Every failure returns `{ error: { code, message, details? } }`.
- **Validation**: Zod schemas drive request validation, response serialization
  *and* the OpenAPI document. A response that doesn't match its schema is a 500,
  not a silent leak.
- **Tenancy**: RLS in the database, plus an explicit `user_id` filter in every
  repository method.

## Scripts

| Command                | Does                                                    |
| ---------------------- | ------------------------------------------------------- |
| `pnpm dev`             | tsx watch, pretty logs                                  |
| `pnpm build`           | `tsc` to `dist/`                                        |
| `pnpm start`           | run the build                                           |
| `pnpm typecheck`       | `tsc --noEmit`                                          |
| `pnpm test`            | vitest                                                  |
| `pnpm db:start` / `db:stop` | local Supabase stack (Docker)                      |
| `pnpm db:reset`        | recreate the local DB and replay every migration        |
| `pnpm db:diff <name>`  | write a migration from local schema drift               |
| `pnpm db:push`         | apply pending migrations to the linked project          |
| `pnpm types:generate`  | regenerate `src/supabase/database.types.ts`             |

## Tests

`test/app.test.ts` is a wiring test — it builds the whole app and asserts that
every module mounts where the registry says, that guards reject anonymous
callers before validation, that the public auth routes are reachable, and that
the OpenAPI document generates. It needs no Supabase project: the guard rejects
a missing token without any network call.

`test/rules.engine.test.ts` covers the rule matcher directly.

There is **no integration suite**. Nothing has been exercised against a real
Supabase project — the SQL in `supabase/migrations/` has not been applied, and
no sign-up, token verification or PostgREST query has actually run. That needs a
suite pointed at a local `supabase start` stack.

## Deploying to Render

`render.yaml` describes the web service only — no Render database, and no
pre-deploy migration step, since the schema lives in Supabase.

**It is not applied.** The running service was created by hand in the dashboard,
so the dashboard is the source of truth today and `render.yaml` records what the
service *should* be. The intent is to adopt it as a blueprint, so keep the two in
step: change one, change the other in the same sitting. Before adopting, diff the
dashboard's environment variables against the file — anything set there and
absent here vanishes on the first sync, and `src/config/env.ts` validates at
import, so the service simply fails to boot.

- Set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
  `AUTH_REDIRECT_URL` and `CORS_ORIGINS` in the dashboard — all are
  `sync: false` so they never land in the blueprint.
- **`PUBLIC_URL` must match the service's real public URL**; the placeholder
  assumes `budj-server.onrender.com`.
- Add `AUTH_REDIRECT_URL` to Supabase's **Auth → URL Configuration** redirect
  allow-list, or confirmation and reset links will be rejected.
- Migrations are applied out of band with `pnpm db:push`, not during deploy.
- `/docs` is disabled when `NODE_ENV=production`.

**Do not run this on Render's free plan.** Free instances spin down after ~15
minutes idle and take 50s or more to wake. The visible symptom is the app
hanging on first open, but the expensive one is silent: Apple's POST to
`/api/billing/apple/notifications` is what wakes the server, so it can time out.
Nothing polls Apple — that webhook and the client's own transaction submission
are the only two writers of the entitlement row — and StoreKit replays only
unfinished purchases, so a refund or an expiry has no second path. A dropped
notification leaves a lapsed user subscribed, their bank connection live, and
Akahu billing for them.

The region is `singapore`: closest to New Zealand users and to the Supabase
project in `ap-southeast-2` (Sydney). Render has no Sydney region. A service's
region cannot be changed after creation — moving it means recreating the service
and re-entering every `sync: false` value.
