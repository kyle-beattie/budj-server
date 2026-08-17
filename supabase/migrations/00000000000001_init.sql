-- Budj initial schema.
--
-- Supabase owns `auth.users`; everything below lives in `public` and keys off it.
-- Every table has RLS enabled with policies scoped to auth.uid(). The API also
-- filters by user_id in its repositories — the two guards are deliberately
-- redundant, so a missed filter fails closed at the database.
--
-- ---------------------------------------------------------------------------
-- MIGRATIONS ARE APPEND-ONLY FROM HERE ONWARD.
-- ---------------------------------------------------------------------------
-- This file was edited in place once, by `add-onboarding`, which was legitimate
-- only because it had never been applied to any database — there was no data to
-- migrate and no deployed environment to diverge from. That is no longer true.
-- Every subsequent schema change gets its own `supabase/migrations/*.sql`.

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
-- The application-owned view of a user. auth.users is managed by Supabase and
-- must not be written to directly; anything we want to store about a person
-- goes here.

create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '',
  avatar_url   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles are viewable by their owner"
  on public.profiles for select
  using (auth.uid() = id);

create policy "profiles are updatable by their owner"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- No insert/delete policy: rows are created by the trigger below and removed by
-- the cascade from auth.users.

-- ---------------------------------------------------------------------------
-- akahu_connections
-- ---------------------------------------------------------------------------
-- One row per bank the user has authorised through Akahu. A user may hold
-- several. Connections are never deleted — revoking sets `disconnected_at`, so
-- accounts that referenced them keep their foreign key and their history.

create table public.akahu_connections (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  -- Akahu's own identifier for the connection (`conn_...`).
  connection_id   text not null,
  name            text not null default '',
  logo_url        text,
  connected_at    timestamptz not null default now(),
  disconnected_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index akahu_connections_user_id_idx on public.akahu_connections (user_id);
create unique index akahu_connections_user_id_connection_id_key
  on public.akahu_connections (user_id, connection_id);

alter table public.akahu_connections enable row level security;

create policy "akahu connections are selectable by their owner"
  on public.akahu_connections for select using (auth.uid() = user_id);

create policy "akahu connections are insertable by their owner"
  on public.akahu_connections for insert with check (auth.uid() = user_id);

create policy "akahu connections are updatable by their owner"
  on public.akahu_connections for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- No delete policy: revoking marks `disconnected_at` rather than removing rows.

-- ---------------------------------------------------------------------------
-- accounts
-- ---------------------------------------------------------------------------
-- A thin, read-only projection of what Akahu reports — not a cache and not a
-- copy. It exists so Postgres can enforce tenancy over Akahu data: a rule
-- referencing someone else's account id is rejected by RLS rather than by an
-- Akahu round trip.
--
-- No balances. A stale balance is worse than no balance, and it is the
-- highest-sensitivity field on offer. Nothing in the product reads one.

create type public.account_type as enum (
  'checking', 'savings', 'credit_card', 'cash', 'loan', 'investment',
  -- Fallback for an Akahu account type this codebase has no mapping for. An
  -- unknown type degrades to `other` rather than failing the whole sync.
  'other'
);

create table public.accounts (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  connection_id    uuid not null references public.akahu_connections (id) on delete cascade,
  -- Akahu's own identifier for the account (`acc_...`).
  akahu_account_id text not null,
  name             text not null,
  type             public.account_type not null,
  currency         char(3) not null default 'NZD',
  -- Two capability flags, not one: Akahu governs paying out and receiving
  -- separately. `payment_from` follows Akahu's PAYMENT_FROM attribute;
  -- `payment_to` follows BECS identifiability. A credit card can trigger a rule
  -- and can never receive money.
  payment_from     boolean not null default false,
  payment_to       boolean not null default false,
  -- Last time Akahu reported this account. Accounts that stop appearing are
  -- marked disconnected, never deleted.
  last_seen_at     timestamptz not null default now(),
  disconnected_at  timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index accounts_user_id_idx on public.accounts (user_id);
create index accounts_connection_id_idx on public.accounts (connection_id);
-- Akahu can legitimately report two accounts with the same name, so the old
-- unique index on (user_id, lower(name)) is gone. Identity is Akahu's id.
create unique index accounts_user_id_akahu_account_id_key
  on public.accounts (user_id, akahu_account_id);

alter table public.accounts enable row level security;

-- Select/insert/update only, and the write policies exist solely so the
-- connection sync can upsert the projection while acting as the user. The API
-- exposes no create, update or delete route — accounts are not user-entered.
create policy "accounts are selectable by their owner"
  on public.accounts for select using (auth.uid() = user_id);

create policy "accounts are insertable by their owner"
  on public.accounts for insert with check (auth.uid() = user_id);

create policy "accounts are updatable by their owner"
  on public.accounts for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- akahu_tokens
-- ---------------------------------------------------------------------------
-- The user's Akahu access token: a bearer credential for someone's bank.
--
-- RLS IS ENABLED AND THERE ARE DELIBERATELY NO POLICIES. PostgREST denies by
-- default, so this table is invisible to the anon and user clients — including
-- a leaked user JWT. Only the service-role client can read it, through the one
-- named accessor `getAkahuToken(userId)`.
--
-- DO NOT "FIX" THIS BY ADDING AN OWNER POLICY. An owner policy would let the
-- iOS app read the token and call Akahu directly, which is the entire threat
-- this design exists to prevent.
--
-- The token is additionally encrypted with a key held in the environment
-- (AKAHU_TOKEN_ENC_KEY), not in Postgres, so a database dump alone does not
-- yield bank access. The ciphertext carries a key-version prefix so the key can
-- be rotated without a flag day.

create table public.akahu_tokens (
  user_id          uuid primary key references auth.users (id) on delete cascade,
  -- Akahu's identifier for the user; the reverse-lookup key a transaction
  -- webhook needs to find whose token to use.
  akahu_user_id    text,
  token_ciphertext text not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index akahu_tokens_akahu_user_id_idx on public.akahu_tokens (akahu_user_id);

alter table public.akahu_tokens enable row level security;

-- ---------------------------------------------------------------------------
-- apple_grants
-- ---------------------------------------------------------------------------
-- Apple's refresh token, obtained by exchanging the one-shot authorization code
-- captured at sign-in. Needed to revoke the user's Apple tokens when they delete
-- their account, which Apple requires and Supabase does not expose.
--
-- Same custody model as akahu_tokens: RLS enabled, NO POLICIES, encrypted at
-- rest, service-role accessor only. See the comment above before changing this.

create table public.apple_grants (
  user_id                  uuid primary key references auth.users (id) on delete cascade,
  refresh_token_ciphertext text not null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

alter table public.apple_grants enable row level security;

-- ---------------------------------------------------------------------------
-- billing_subscriptions
-- ---------------------------------------------------------------------------
-- *Our* entitlement record, keyed by our user id. The App Store knows about a
-- purchase; only this table knows which account it entitles.

create type public.subscription_status as enum (
  'active', 'grace_period', 'expired', 'revoked'
);

create table public.billing_subscriptions (
  user_id                 uuid primary key references auth.users (id) on delete cascade,
  -- Apple's stable key across renewals. UNIQUE is load-bearing: without it one
  -- App Store subscription can entitle two accounts, and subscription sharing
  -- becomes a one-line exploit.
  original_transaction_id text not null,
  product_id              text not null,
  plan_code               text not null,
  status                  public.subscription_status not null,
  expires_at              timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create unique index billing_subscriptions_original_transaction_id_key
  on public.billing_subscriptions (original_transaction_id);

alter table public.billing_subscriptions enable row level security;

-- Select only. The server writes this row — from the App Store Server
-- Notifications handler and from verified transaction submission, both of which
-- run as service role. A user who could insert here could grant themselves a
-- subscription.
create policy "subscriptions are selectable by their owner"
  on public.billing_subscriptions for select using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- device_registrations
-- ---------------------------------------------------------------------------
-- Somewhere to send an APNs push. No cryptographic key material: an identifier
-- and a token, nothing else (D10). Revoking marks `revoked_at` rather than
-- deleting, so a re-registration is distinguishable from a first one.

create table public.device_registrations (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  device_id     text not null,
  apns_token    text not null,
  registered_at timestamptz not null default now(),
  revoked_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index device_registrations_user_id_idx on public.device_registrations (user_id);
create unique index device_registrations_user_id_device_id_key
  on public.device_registrations (user_id, device_id);

alter table public.device_registrations enable row level security;

create policy "devices are selectable by their owner"
  on public.device_registrations for select using (auth.uid() = user_id);

create policy "devices are insertable by their owner"
  on public.device_registrations for insert with check (auth.uid() = user_id);

create policy "devices are updatable by their owner"
  on public.device_registrations for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- No delete policy: revoking marks `revoked_at`.

-- ---------------------------------------------------------------------------
-- rules
-- ---------------------------------------------------------------------------
-- conditions/actions are jsonb so the shape can evolve without a migration;
-- src/modules/rules/rules.types.ts is the source of truth for what is valid.

create table public.rules (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  name            text not null,
  description     text,
  -- Lower runs first. Ties break on created_at.
  priority        integer not null default 100,
  is_enabled      boolean not null default true,
  conditions      jsonb not null default '[]'::jsonb,
  actions         jsonb not null default '[]'::jsonb,
  -- Stop evaluating further rules once this one matches.
  stop_processing boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index rules_user_id_idx on public.rules (user_id);
create index rules_user_id_priority_idx on public.rules (user_id, priority);

alter table public.rules enable row level security;

create policy "rules are selectable by their owner"
  on public.rules for select using (auth.uid() = user_id);

create policy "rules are insertable by their owner"
  on public.rules for insert with check (auth.uid() = user_id);

create policy "rules are updatable by their owner"
  on public.rules for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "rules are deletable by their owner"
  on public.rules for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- triggers
-- ---------------------------------------------------------------------------

-- Keep updated_at honest without the API having to remember to set it.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

create trigger accounts_set_updated_at
  before update on public.accounts
  for each row execute function public.set_updated_at();

create trigger rules_set_updated_at
  before update on public.rules
  for each row execute function public.set_updated_at();

create trigger akahu_connections_set_updated_at
  before update on public.akahu_connections
  for each row execute function public.set_updated_at();

create trigger akahu_tokens_set_updated_at
  before update on public.akahu_tokens
  for each row execute function public.set_updated_at();

create trigger apple_grants_set_updated_at
  before update on public.apple_grants
  for each row execute function public.set_updated_at();

create trigger billing_subscriptions_set_updated_at
  before update on public.billing_subscriptions
  for each row execute function public.set_updated_at();

create trigger device_registrations_set_updated_at
  before update on public.device_registrations
  for each row execute function public.set_updated_at();

-- Every new auth user gets a profile row. `security definer` is required to
-- write to public.profiles from the auth schema's trigger context; the empty
-- search_path is the standard hardening for such functions.
--
-- The display name comes from the metadata our own sign-up sends
-- (`display_name`), then from the OAuth identity claims (`full_name` from Apple
-- and Google, `name` from Google), and otherwise from nothing at all.
--
-- IT MUST NEVER FALL BACK TO THE EMAIL LOCAL PART. Apple's Hide My Email
-- produces addresses like `xyzabc123@privaterelay.appleid.com`, so that fallback
-- names people `xyzabc123`. An empty display name is a prompt the app can
-- resolve; a relay fragment looks like a real answer and never gets corrected.
--
-- Related: Apple supplies the user's real name exactly once, on the first
-- authorisation ever. If the iOS app does not send it on its first
-- `signInWithIdToken` call it is unrecoverable without the user revoking the app
-- in iOS settings.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'display_name', ''),
      nullif(new.raw_user_meta_data ->> 'full_name', ''),
      nullif(new.raw_user_meta_data ->> 'name', ''),
      ''
    ),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
