-- Budj initial schema.
--
-- Supabase owns `auth.users`; everything below lives in `public` and keys off it.
-- Every table has RLS enabled with policies scoped to auth.uid(). The API also
-- filters by user_id in its repositories — the two guards are deliberately
-- redundant, so a missed filter fails closed at the database.

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
-- accounts
-- ---------------------------------------------------------------------------

create type public.account_type as enum (
  'checking', 'savings', 'credit_card', 'cash', 'loan', 'investment'
);

create table public.accounts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  name         text not null,
  type         public.account_type not null,
  currency     char(3) not null default 'GBP',
  -- Money is numeric, never a float. PostgREST returns it as a string.
  balance      numeric(14, 2) not null default 0,
  institution  text,
  is_archived  boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index accounts_user_id_idx on public.accounts (user_id);
create unique index accounts_user_id_name_key on public.accounts (user_id, lower(name));

alter table public.accounts enable row level security;

create policy "accounts are selectable by their owner"
  on public.accounts for select using (auth.uid() = user_id);

create policy "accounts are insertable by their owner"
  on public.accounts for insert with check (auth.uid() = user_id);

create policy "accounts are updatable by their owner"
  on public.accounts for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "accounts are deletable by their owner"
  on public.accounts for delete using (auth.uid() = user_id);

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

-- Every new auth user gets a profile row. `security definer` is required to
-- write to public.profiles from the auth schema's trigger context; the empty
-- search_path is the standard hardening for such functions.
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
      new.raw_user_meta_data ->> 'display_name',
      new.raw_user_meta_data ->> 'name',
      split_part(new.email, '@', 1),
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
